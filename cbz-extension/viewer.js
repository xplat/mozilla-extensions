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
// Used for file:// URLs. Extension pages can't fetch() file:// URLs in Firefox,
// so reads are relayed through the background script to the native messaging
// host. The host caps reads at 512 KB; larger reads are split here.

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
    // 512 KB raw → ~683 KB base64 → safely under the 1 MB native message limit
    // even accounting for JSON framing overhead.
    const CHUNK = 512 * 1024;
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
  accessor: null,       // FileAccessor instance — the only reference to file data
  entries: [],          // image entry metadata only (no file bytes)
  currentPage: 1,
  totalPages: 0,
  srcUrl: '',
  blobUrls: {},         // decoded image cache: pageNum -> blob: URL
  extracting: {},       // in-flight extraction promises: pageNum -> Promise<string>
                        // Deduplicates concurrent requests for the same page so
                        // prefetch and displayPage never both extract the same entry.
};

// ─── UI HELPERS ──────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

function setStatus(msg) { $('status-text').textContent = msg; }

function showLoading(msg = 'Loading…') {
  $('pick-screen').classList.add('hidden');
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
  $('page-total').textContent    = state.totalPages;
  $('prev-btn').disabled         = state.currentPage <= 1;
  $('next-btn').disabled         = state.currentPage >= state.totalPages;
  $('page-input').value          = state.currentPage;
  $('page-input').max            = state.totalPages;
}

function setTitle(name) {
  const display = name.replace(/\.cbz$/i, '');
  document.title = display + ' \u2014 CBZ Viewer';
  $('comic-title').textContent = display;
}

// ─── PAGE EXTRACTION (deduplicated) ──────────────────────────────────────────
// Returns a blob: URL for the given page, extracting it if needed.
// Uses state.extracting to ensure only one extraction runs per page at a time:
// if displayPage and prefetchPage both want the same page, the second caller
// just awaits the first's promise rather than starting a duplicate extraction.

async function getPageBlobUrl(pageNum, updateStatus) {
  if (state.blobUrls[pageNum]) return state.blobUrls[pageNum];

  if (!state.extracting[pageNum]) {
    state.extracting[pageNum] = (async () => {
      const entry = state.entries[pageNum - 1];
      if (updateStatus) setStatus(`Extracting page ${pageNum}…`);
      const data = await extractEntry(state.accessor, entry);
      const url  = URL.createObjectURL(new Blob([data], { type: getMimeType(entry.name) }));
      state.blobUrls[pageNum]   = url;
      delete state.extracting[pageNum];
      return url;
    })();
  }

  return state.extracting[pageNum];
}

// ─── PAGE DISPLAY ────────────────────────────────────────────────────────────

async function displayPage(pageNum) {
  if (pageNum < 1 || pageNum > state.totalPages) return;
  state.currentPage = pageNum;

  // Always return to fit mode when navigating to a new page
  setZoom('fit');

  const img     = $('comic-image');
  const spinner = $('page-spinner');
  img.classList.add('loading');
  spinner.classList.remove('hidden');

  try {
    const blobUrl = await getPageBlobUrl(pageNum, /*updateStatus=*/true);

    await new Promise((resolve, reject) => {
      img.onload  = resolve;
      img.onerror = reject;
      img.src     = blobUrl;
    });

    updatePageUI();

    // Store current page in ?page= so session restore and reloads preserve it.
    const u = new URL(window.location.href);
    u.searchParams.set('page', pageNum);
    history.replaceState(null, '', u.toString());

    prefetchPage(pageNum + 1);
    prefetchPage(pageNum - 1);

  } catch (err) {
    console.error('Page display error:', err);
    // Show the error visibly — setStatus alone is too subtle when the viewer
    // is already displayed and the image just fails silently.
    img.classList.remove('loading');
    spinner.classList.add('hidden');
    img.removeAttribute('src');
    // Revert page counter to last known good page so UI isn't misleading
    state.currentPage = pageNum;
    updatePageUI();
    showError(`Failed to load page ${pageNum}: ${err.message}`);
    return;
  } finally {
    img.classList.remove('loading');
    spinner.classList.add('hidden');
  }
}

async function prefetchPage(pageNum) {
  if (pageNum < 1 || pageNum > state.totalPages) return;
  if (state.blobUrls[pageNum]) return;
  try { await getPageBlobUrl(pageNum, /*updateStatus=*/false); }
  catch (_) { /* silent prefetch failure */ }
}

// ─── ACCESSOR FACTORY ────────────────────────────────────────────────────────

async function createAccessor(url) {
  if (url.startsWith('file://')) {
    // Extension pages cannot fetch() file:// URLs in Firefox.
    // Extract the filesystem path from the URL and use NativeAccessor.
    const path = decodeURIComponent(new URL(url).pathname);
    return NativeAccessor.create(path);
  }

  if (url.startsWith('blob:')) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('Could not read blob URL');
    return new BlobAccessor(await resp.blob());
  }

  if (url.startsWith('http:') || url.startsWith('https:')) {
    return HttpAccessor.create(url);
  }

  throw new Error(`Unsupported URL scheme: ${url.split(':')[0]}`);
}

// ─── MAIN LOAD ───────────────────────────────────────────────────────────────

// Core loader — works directly from an accessor (used by in-tab file picker)
async function loadWithAccessor(accessor, startPage) {
  showLoading('Opening…');
  try {
    state.accessor   = accessor;
    state.blobUrls   = {};   // clear any previous page cache
    state.extracting = {};   // clear any in-flight extractions

    const allEntries = await parseCentralDirectory(state.accessor);
    state.entries    = filterAndSortImages(allEntries);
    state.totalPages = state.entries.length;

    if (state.totalPages === 0) throw new Error('No image files found in this CBZ archive.');

    showViewer();
    updatePageUI();
    await displayPage(Math.max(1, Math.min(startPage, state.totalPages)));

  } catch (err) {
    console.error('Load error:', err);
    showError(err.message || 'Failed to load the CBZ file.');
  }
}

// URL-based loader — creates an accessor from a URL then calls loadWithAccessor
async function loadCbz(url, startPage) {
  showLoading('Opening…');
  try {
    const accessor = await createAccessor(url);

    // Set title from URL path if not already set from a name param
    if ($('comic-title').textContent === 'Comic') {
      try {
        const name = decodeURIComponent(new URL(url).pathname.split('/').pop());
        if (name) setTitle(name);
      } catch (_) {}
    }

    await loadWithAccessor(accessor, startPage);

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

// ─── ZOOM TOGGLE ─────────────────────────────────────────────────────────────
// Two modes: 'fit' (default) — image constrained to the viewport with
// max-width/max-height; 'full' — image at natural size with scrollbars.
// Clicking the middle third of the page area toggles between them.
// Navigating to a new page always resets to 'fit'.

let zoomMode = 'fit';

function setZoom(mode) {
  zoomMode = mode;
  const img = $('comic-image');
  const container = $('page-container');
  if (mode === 'full') {
    img.style.maxWidth  = 'none';
    img.style.maxHeight = 'none';
    container.style.overflow = 'auto';
    container.style.alignItems = 'flex-start';
    container.style.justifyContent = 'flex-start';
  } else {
    img.style.maxWidth  = '';
    img.style.maxHeight = '';
    container.style.overflow = 'hidden';
    container.style.alignItems = '';
    container.style.justifyContent = '';
  }
}

$('page-container').addEventListener('click', e => {
  // Ignore clicks on the topbar or spinner
  if (e.target.closest('#topbar') || e.target.closest('.page-spinner')) return;

  const rect = $('page-container').getBoundingClientRect();
  const x = e.clientX - rect.left;
  const third = rect.width / 3;

  if (x < third) {
    goToPage(state.currentPage - 1);
  } else if (x > third * 2) {
    goToPage(state.currentPage + 1);
  } else {
    setZoom(zoomMode === 'fit' ? 'full' : 'fit');
  }
});

// ─── FILE PICKER (in-tab) ────────────────────────────────────────────────────
// When no src is provided, show the pick screen. The file input lives in the
// viewer tab itself, so the File object and its Blob are in the same context —
// no cross-context transfer needed at all.

function openFileFromPicker(file) {
  if (!file) return;
  // Wrap the File (which is a Blob) directly in BlobAccessor.
  // File.arrayBuffer() / File.slice() work identically to Blob — no copy made.
  state.srcUrl = 'local:' + file.name;
  setTitle(file.name);
  const accessor = new BlobAccessor(file);
  loadWithAccessor(accessor, 1);
}

function wireFilePicker(btnId, inputId) {
  $(btnId).addEventListener('click', () => $(inputId).click());
  $(inputId).addEventListener('change', e => openFileFromPicker(e.target.files[0]));
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

(function init() {
  // Wire up the in-tab file pickers (pick screen + error screen retry button)
  wireFilePicker('pick-btn',        'pick-file-input');
  wireFilePicker('error-open-btn',  'error-file-input');

  const params = new URLSearchParams(window.location.search);
  const src    = params.get('src');

  if (!src) {
    // No source URL — show the pick screen instead of an error
    $('loading-screen').classList.add('hidden');
    $('pick-screen').classList.remove('hidden');
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
