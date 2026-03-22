// viewer.js — CBZ parser and comic reader
'use strict';

// ─── BINARY HELPERS ──────────────────────────────────────────────────────────

function readUint16LE(buf, offset) {
  return buf[offset] | (buf[offset + 1] << 8);
}

function readUint32LE(buf, offset) {
  return (buf[offset] | (buf[offset + 1] << 8) |
          (buf[offset + 2] << 16) | (buf[offset + 3] << 24)) >>> 0;
}

function readUint64LE(buf, offset) {
  // IEEE-754 double has 53-bit mantissa → exact integers up to 2^53-1 (~8 PB).
  // hi * 2^32 + lo is exact while hi < 2^21, covering all realistic archive sizes.
  const lo = readUint32LE(buf, offset);
  const hi = readUint32LE(buf, offset + 4);
  return hi * 0x100000000 + lo;
}

// ─── FILE ACCESSOR ABSTRACTION ───────────────────────────────────────────────
//
// All three source types expose the same interface:
//   accessor.size              → number (total file size in bytes)
//   accessor.read(offset, len) → Promise<Uint8Array>
//
// This lets the ZIP parser fetch only the tail to find the EOCD, then only the
// central directory bytes, then only each entry's compressed data on demand.
// No full-file buffer is ever held in the JS heap.

// ── BlobAccessor ─────────────────────────────────────────────────────────────
// Used for blob: URLs from the popup file picker.
// The Blob lives in browser-managed storage; slice() is zero-copy.

class BlobAccessor {
  constructor(blob) {
    this._blob = blob;
    this.size = blob.size;
  }
  async read(offset, length) {
    const ab = await this._blob.slice(offset, offset + length).arrayBuffer();
    return new Uint8Array(ab);
  }
}

// ── HttpAccessor ─────────────────────────────────────────────────────────────
// Used for http:// and https:// sources.
// Uses Range requests when the server supports them (Accept-Ranges: bytes).
// Falls back to a full download stored as a Blob if Range is unsupported.

class HttpAccessor {
  constructor(url, size, blob) {
    this._url  = url;
    this._blob = blob; // non-null in fallback mode
    this.size  = size;
  }

  static async create(url) {
    // Probe for Range support
    let size = null;
    let rangeOk = false;
    try {
      const head = await fetch(url, { method: 'HEAD' });
      if (head.ok) {
        const cl = head.headers.get('content-length');
        if (cl) size = parseInt(cl, 10);
        const ar = head.headers.get('accept-ranges');
        rangeOk = !!(ar && ar.toLowerCase() !== 'none');
      }
    } catch (_) { /* HEAD not supported */ }

    if (rangeOk && size !== null) {
      return new HttpAccessor(url, size, null);
    }

    // Fallback: stream entire file into a Blob (avoids double-buffering)
    setStatus('Downloading…');
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    const cl = resp.headers.get('content-length');
    if (cl) setStatus(`Downloading… (${(parseInt(cl)/1024/1024).toFixed(1)} MB)`);
    const blob = await resp.blob();
    return new HttpAccessor(url, blob.size, blob);
  }

  async read(offset, length) {
    if (this._blob) {
      const ab = await this._blob.slice(offset, offset + length).arrayBuffer();
      return new Uint8Array(ab);
    }
    const resp = await fetch(this._url, {
      headers: { 'Range': `bytes=${offset}-${offset + length - 1}` }
    });
    if (resp.status !== 206 && !resp.ok) {
      throw new Error(`Range request failed: HTTP ${resp.status}`);
    }
    return new Uint8Array(await resp.arrayBuffer());
  }
}

// ── NativeAccessor ───────────────────────────────────────────────────────────
// Used for files opened via cbz-open (native messaging).
// Reads are relayed through the background script to the native host.
// The host caps individual reads at 768 KB; larger reads are split here.

class NativeAccessor {
  constructor(path, size) {
    this._path = path;
    this.size  = size;
  }

  static async create(path) {
    const resp = await bgMessage({ type: 'nativeStat', path });
    if (!resp.ok) throw new Error(resp.error || 'Could not stat file');
    return new NativeAccessor(path, resp.size);
  }

  async read(offset, length) {
    const CHUNK = 768 * 1024;
    if (length <= CHUNK) return this._chunk(offset, length);
    const out = new Uint8Array(length);
    let pos = 0;
    while (pos < length) {
      const n = Math.min(CHUNK, length - pos);
      const part = await this._chunk(offset + pos, n);
      out.set(part, pos);
      pos += part.length;
    }
    return out;
  }

  async _chunk(offset, length) {
    const resp = await bgMessage({ type: 'nativeRead', path: this._path, offset, length });
    if (!resp.ok) throw new Error(resp.error || 'Chunk read failed');
    const binary = atob(resp.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
}

function bgMessage(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// ─── ZIP PARSING (lazy, accessor-based) ──────────────────────────────────────
//
// We never read the whole file. Steps:
//   1. Read the last min(fileSize, 65557) bytes to locate the EOCD record.
//   2. Read the ZIP64 EOCD + locator if present (56 + 20 bytes).
//   3. Read the central directory (metadata only, no file data).
//   4. Each entry's compressed data is read on demand in extractEntry().

const EOCD_MAX_TAIL = 22 + 65535;

async function findAndParseEOCD(accessor) {
  const tailSize   = Math.min(accessor.size, EOCD_MAX_TAIL);
  const tailOffset = accessor.size - tailSize;
  const tail       = await accessor.read(tailOffset, tailSize);

  // Scan backwards for PK\x05\x06
  let eocdPos = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i]===0x50 && tail[i+1]===0x4B &&
        tail[i+2]===0x05 && tail[i+3]===0x06) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos < 0) throw new Error('Not a valid ZIP file: EOCD not found');

  const eocdAbsolute = tailOffset + eocdPos;
  let cdOffset, cdSize, totalEntries;

  // Check for ZIP64 EOCD locator (PK\x06\x07) immediately before EOCD
  const locAbsolute = eocdAbsolute - 20;
  if (locAbsolute >= 0) {
    const loc = await accessor.read(locAbsolute, 20);
    if (loc[0]===0x50 && loc[1]===0x4B && loc[2]===0x06 && loc[3]===0x07) {
      const eocd64Absolute = readUint64LE(loc, 8);
      if (eocd64Absolute < accessor.size) {
        const e64 = await accessor.read(eocd64Absolute, 56);
        if (e64[0]===0x50 && e64[1]===0x4B && e64[2]===0x06 && e64[3]===0x06) {
          totalEntries = readUint64LE(e64, 32);
          cdSize       = readUint64LE(e64, 40);
          cdOffset     = readUint64LE(e64, 48);
        }
      }
    }
  }

  if (cdOffset === undefined) {
    // Standard ZIP32
    totalEntries = readUint16LE(tail, eocdPos + 10);
    cdSize       = readUint32LE(tail, eocdPos + 12);
    cdOffset     = readUint32LE(tail, eocdPos + 16);
  }

  return { cdOffset, cdSize, totalEntries };
}

function decodeName(bytes, isUtf8) {
  if (isUtf8) return new TextDecoder('utf-8').decode(bytes);
  try   { return new TextDecoder('utf-8').decode(bytes); }
  catch { return new TextDecoder('latin1').decode(bytes); }
}

async function parseCentralDirectory(accessor) {
  setStatus('Reading ZIP directory…');
  const { cdOffset, cdSize, totalEntries } = await findAndParseEOCD(accessor);

  // Read the entire central directory at once — it's pure metadata.
  // Even a 1000-issue omnibus typically has a CD under a few MB.
  const cd = await accessor.read(cdOffset, cdSize);

  const entries = [];
  let pos = 0;

  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > cd.length) break;
    if (readUint32LE(cd, pos) !== 0x02014b50) break;

    const flags           = readUint16LE(cd, pos + 8);
    const compression     = readUint16LE(cd, pos + 10);
    let compressedSize    = readUint32LE(cd, pos + 20);
    let uncompressedSize  = readUint32LE(cd, pos + 24);
    const nameLen         = readUint16LE(cd, pos + 28);
    const extraLen        = readUint16LE(cd, pos + 30);
    const commentLen      = readUint16LE(cd, pos + 32);
    let localOffset       = readUint32LE(cd, pos + 42);
    const isUtf8          = (flags & 0x0800) !== 0;

    const name = decodeName(cd.slice(pos + 46, pos + 46 + nameLen), isUtf8);

    // Resolve ZIP64 extra fields if sentinel values are present
    if (compressedSize === 0xFFFFFFFF || uncompressedSize === 0xFFFFFFFF ||
        localOffset === 0xFFFFFFFF) {
      let ep = pos + 46 + nameLen;
      const extraEnd = ep + extraLen;
      while (ep + 4 <= extraEnd) {
        const headerId = readUint16LE(cd, ep);
        const dataSize = readUint16LE(cd, ep + 2);
        if (headerId === 0x0001) {
          let z = ep + 4;
          if (uncompressedSize === 0xFFFFFFFF && z + 8 <= extraEnd) {
            uncompressedSize = readUint64LE(cd, z); z += 8;
          }
          if (compressedSize === 0xFFFFFFFF && z + 8 <= extraEnd) {
            compressedSize = readUint64LE(cd, z); z += 8;
          }
          if (localOffset === 0xFFFFFFFF && z + 8 <= extraEnd) {
            localOffset = readUint64LE(cd, z); z += 8;
          }
          break;
        }
        ep += 4 + dataSize;
      }
    }

    entries.push({ name, compression, compressedSize, uncompressedSize, localOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

// ─── ENTRY EXTRACTION ────────────────────────────────────────────────────────
// Reads only the local file header (to find data offset) and compressed bytes.

async function extractEntry(accessor, entry) {
  // Local file header fixed part is 30 bytes
  const lh = await accessor.read(entry.localOffset, 30);
  if (readUint32LE(lh, 0) !== 0x04034b50) {
    throw new Error('Bad local file header signature');
  }
  const dataOffset = entry.localOffset + 30 +
                     readUint16LE(lh, 26) +  // name length
                     readUint16LE(lh, 28);   // extra length

  const compressed = await accessor.read(dataOffset, entry.compressedSize);

  if      (entry.compression === 0) return compressed;
  else if (entry.compression === 8) return inflateDeflate(compressed);
  else throw new Error(`Unsupported compression method: ${entry.compression}`);
}

async function inflateDeflate(data) {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  writer.write(data);
  writer.close();

  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// ─── IMAGE FILTERING / MIME ───────────────────────────────────────────────────

const IMAGE_EXTENSIONS = new Set([
  'jpg','jpeg','png','gif','webp','avif','bmp','tiff','tif'
]);

function filterAndSortImages(entries) {
  return entries
    .filter(e => {
      if (e.name.endsWith('/')) return false;
      const ext = e.name.split('.').pop().toLowerCase();
      return IMAGE_EXTENSIONS.has(ext);
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined,
                      { numeric: true, sensitivity: 'base' }));
}

function getMimeType(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  return { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png',
           gif:'image/gif',  webp:'image/webp', avif:'image/avif',
           bmp:'image/bmp',  tiff:'image/tiff', tif:'image/tiff' }[ext]
         || 'image/jpeg';
}

// ─── FRAGMENT PARSING ────────────────────────────────────────────────────────

function parseFragment(hash) {
  const frag = hash.startsWith('#') ? hash.slice(1) : hash;
  let page = 1;
  for (const p of frag.split('&')) {
    if (p.startsWith('page=')) {
      const n = parseInt(p.slice(5), 10);
      if (!isNaN(n) && n >= 1) page = n;
    }
  }
  return { page };
}

// ─── UI STATE ────────────────────────────────────────────────────────────────

let state = {
  accessor: null,   // FileAccessor instance — the only reference to file data
  entries: [],      // image entry metadata only (no file bytes)
  currentPage: 1,
  totalPages: 0,
  srcUrl: '',
  blobUrls: {},     // decoded image cache: pageNum -> blob: URL
};

// ─── UI HELPERS ──────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

function setStatus(msg) { $('status-text').textContent = msg; }

function showLoading(msg = 'Loading…') {
  $('loading-screen').classList.remove('hidden');
  $('viewer-screen').classList.add('hidden');
  $('error-screen').classList.add('hidden');
  setStatus(msg);
}

function showError(msg) {
  $('loading-screen').classList.add('hidden');
  $('viewer-screen').classList.add('hidden');
  $('error-screen').classList.remove('hidden');
  $('error-message').textContent = msg;
}

function showViewer() {
  $('loading-screen').classList.add('hidden');
  $('error-screen').classList.add('hidden');
  $('viewer-screen').classList.remove('hidden');
}

function updatePageUI() {
  $('page-indicator').textContent = `${state.currentPage} / ${state.totalPages}`;
  $('prev-btn').disabled = state.currentPage <= 1;
  $('next-btn').disabled = state.currentPage >= state.totalPages;
  $('page-input').value  = state.currentPage;
  $('page-input').max    = state.totalPages;
}

function setTitle(name) {
  const display = name.replace(/\.cbz$/i, '');
  document.title = display + ' \u2014 CBZ Viewer';
  $('comic-title').textContent = display;
}

// ─── PAGE DISPLAY ────────────────────────────────────────────────────────────

async function displayPage(pageNum) {
  if (pageNum < 1 || pageNum > state.totalPages) return;
  state.currentPage = pageNum;

  const img     = $('comic-image');
  const spinner = $('page-spinner');
  img.classList.add('loading');
  spinner.classList.remove('hidden');

  try {
    let blobUrl = state.blobUrls[pageNum];
    if (!blobUrl) {
      const entry = state.entries[pageNum - 1];
      setStatus(`Extracting page ${pageNum}…`);
      const data = await extractEntry(state.accessor, entry);
      blobUrl = URL.createObjectURL(new Blob([data], { type: getMimeType(entry.name) }));
      state.blobUrls[pageNum] = blobUrl;
    }

    await new Promise((resolve, reject) => {
      img.onload  = resolve;
      img.onerror = reject;
      img.src     = blobUrl;
    });

    updatePageUI();

    const u = new URL(window.location.href);
    u.hash = `cbz&page=${pageNum}`;
    history.replaceState(null, '', u.toString());

    prefetchPage(pageNum + 1);
    prefetchPage(pageNum - 1);

  } catch (err) {
    console.error('Page display error:', err);
    setStatus(`Error on page ${pageNum}: ${err.message}`);
  } finally {
    img.classList.remove('loading');
    spinner.classList.add('hidden');
  }
}

async function prefetchPage(pageNum) {
  if (pageNum < 1 || pageNum > state.totalPages) return;
  if (state.blobUrls[pageNum]) return;
  try {
    const entry = state.entries[pageNum - 1];
    const data  = await extractEntry(state.accessor, entry);
    state.blobUrls[pageNum] = URL.createObjectURL(
      new Blob([data], { type: getMimeType(entry.name) })
    );
  } catch (_) { /* silent */ }
}

// ─── ACCESSOR FACTORY ────────────────────────────────────────────────────────

async function createAccessor(url) {
  if (url.startsWith('cbz-native://')) {
    const path = decodeURIComponent(url.slice('cbz-native://'.length));
    return NativeAccessor.create(path);
  }
  if (url.startsWith('blob:')) {
    // fetch() a blob: URL to get the underlying Blob object.
    // The Blob is browser-managed storage, not JS heap.
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('Could not read blob URL');
    return new BlobAccessor(await resp.blob());
  }
  if (url.startsWith('http:') || url.startsWith('https:')) {
    return HttpAccessor.create(url);
  }
  // Fallback (e.g. unexpected file:// that wasn't caught by webRequest)
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Could not fetch: ${url}`);
  return new BlobAccessor(await resp.blob());
}

// ─── MAIN LOAD ───────────────────────────────────────────────────────────────

async function loadCbz(url, startPage) {
  showLoading('Opening…');
  try {
    state.accessor = await createAccessor(url);

    const allEntries   = await parseCentralDirectory(state.accessor);
    state.entries      = filterAndSortImages(allEntries);
    state.totalPages   = state.entries.length;

    if (state.totalPages === 0) throw new Error('No image files found in this CBZ archive.');

    // Set title from URL path if not already set by init() from a name param
    if ($('comic-title').textContent === 'Comic') {
      try {
        const name = decodeURIComponent(new URL(url).pathname.split('/').pop());
        if (name) setTitle(name);
      } catch (_) {}
    }

    showViewer();
    updatePageUI();
    await displayPage(Math.max(1, Math.min(startPage, state.totalPages)));

  } catch (err) {
    console.error('Load error:', err);
    showError(err.message || 'Failed to load the CBZ file.');
  }
}

// ─── NAVIGATION ──────────────────────────────────────────────────────────────

function goToPage(n) {
  const page = Math.max(1, Math.min(n, state.totalPages));
  if (page !== state.currentPage) displayPage(page);
}

// ─── EVENT LISTENERS ─────────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  switch (e.key) {
    case 'ArrowRight': case 'ArrowDown': case ' ': case 'PageDown':
      e.preventDefault(); goToPage(state.currentPage + 1); break;
    case 'ArrowLeft': case 'ArrowUp': case 'PageUp':
      e.preventDefault(); goToPage(state.currentPage - 1); break;
    case 'Home': goToPage(1); break;
    case 'End':  goToPage(state.totalPages); break;
  }
});

$('prev-btn').addEventListener('click', () => goToPage(state.currentPage - 1));
$('next-btn').addEventListener('click', () => goToPage(state.currentPage + 1));

$('page-input').addEventListener('change', e => {
  const n = parseInt(e.target.value, 10);
  if (!isNaN(n)) goToPage(n);
});
$('page-input').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const n = parseInt(e.target.value, 10);
  if (!isNaN(n)) goToPage(n);
  e.target.blur();
});

$('comic-image').addEventListener('click', e => {
  const rect = e.target.getBoundingClientRect();
  goToPage(e.clientX - rect.left < rect.width / 2
    ? state.currentPage - 1
    : state.currentPage + 1);
});

// ─── INIT ─────────────────────────────────────────────────────────────────────

(function init() {
  const params = new URLSearchParams(window.location.search);
  const src    = params.get('src');

  if (!src) {
    showError('No CBZ source URL provided. Open a .cbz file using the toolbar button, or navigate to a .cbz URL.');
    return;
  }

  state.srcUrl = src;

  const nameParam = params.get('name');
  if (nameParam) setTitle(decodeURIComponent(nameParam));

  // Starting page: ?page= param > #fragment > src URL fragment
  let startPage = 1;
  const pageParam = params.get('page');
  if (pageParam) {
    const n = parseInt(pageParam, 10);
    if (!isNaN(n) && n >= 1) startPage = n;
  } else {
    const hash = window.location.hash;
    if (hash) {
      startPage = parseFragment(hash).page;
    } else {
      try {
        const srcHash = new URL(src).hash;
        if (srcHash) startPage = parseFragment(srcHash).page;
      } catch (_) {}
    }
  }

  loadCbz(src, startPage);
})();
