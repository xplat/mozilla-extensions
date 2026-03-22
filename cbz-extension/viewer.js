// viewer.js — CBZ parser and comic reader

'use strict';

// ─── ZIP PARSING ─────────────────────────────────────────────────────────────

const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'tiff', 'tif'
]);

function readUint16LE(buf, offset) {
  return buf[offset] | (buf[offset + 1] << 8);
}

function readUint32LE(buf, offset) {
  return (buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24)) >>> 0;
}

function readUint64LE(buf, offset) {
  // We only need this for offsets; JS can't handle full 64-bit but
  // comics won't be > 4GB so treat lower 32 bits as sufficient.
  const lo = readUint32LE(buf, offset);
  const hi = readUint32LE(buf, offset + 4);
  if (hi > 0) return Number.MAX_SAFE_INTEGER; // pathological
  return lo;
}

/**
 * Find the End of Central Directory record.
 * Scans backwards from end of file.
 */
function findEOCD(buf) {
  // Signature: PK\x05\x06
  const sig = 0x06054b50;
  // Minimum EOCD size is 22 bytes; comment can be up to 65535 bytes
  const maxSearch = Math.min(buf.length, 22 + 65535);
  for (let i = buf.length - 22; i >= buf.length - maxSearch; i--) {
    if (buf[i] === 0x50 && buf[i+1] === 0x4B && buf[i+2] === 0x05 && buf[i+3] === 0x06) {
      return i;
    }
  }
  return -1;
}

/**
 * Find ZIP64 End of Central Directory record.
 */
function findEOCD64(buf, eocdOffset) {
  // Look for ZIP64 EOCD locator just before EOCD
  const locOffset = eocdOffset - 20;
  if (locOffset < 0) return null;
  if (buf[locOffset] !== 0x50 || buf[locOffset+1] !== 0x4B ||
      buf[locOffset+2] !== 0x06 || buf[locOffset+3] !== 0x07) {
    return null;
  }
  // Offset of ZIP64 EOCD is at bytes 8-15 of locator
  const eocd64Offset = readUint64LE(buf, locOffset + 8);
  if (eocd64Offset >= buf.length) return null;
  if (buf[eocd64Offset] !== 0x50 || buf[eocd64Offset+1] !== 0x4B ||
      buf[eocd64Offset+2] !== 0x06 || buf[eocd64Offset+3] !== 0x06) {
    return null;
  }
  return eocd64Offset;
}

/**
 * Decode a filename from bytes (UTF-8 if flag set, otherwise CP437 approximation).
 */
function decodeName(bytes, isUtf8) {
  if (isUtf8) {
    return new TextDecoder('utf-8').decode(bytes);
  }
  // CP437: basic ASCII range is identical; extended chars approximated
  // For comic filenames this is almost always fine.
  try {
    return new TextDecoder('utf-8').decode(bytes);
  } catch (e) {
    return new TextDecoder('latin1').decode(bytes);
  }
}

/**
 * Parse the central directory and return an array of entry metadata.
 */
function parseCentralDirectory(buf) {
  const eocdOffset = findEOCD(buf);
  if (eocdOffset < 0) throw new Error('Not a valid ZIP file: EOCD not found');

  let cdOffset, cdSize, totalEntries;

  // Check for ZIP64
  const eocd64Offset = findEOCD64(buf, eocdOffset);
  if (eocd64Offset !== null) {
    totalEntries = readUint64LE(buf, eocd64Offset + 32);
    cdSize       = readUint64LE(buf, eocd64Offset + 40);
    cdOffset     = readUint64LE(buf, eocd64Offset + 48);
  } else {
    totalEntries = readUint16LE(buf, eocdOffset + 10);
    cdSize       = readUint32LE(buf, eocdOffset + 12);
    cdOffset     = readUint32LE(buf, eocdOffset + 16);
  }

  const entries = [];
  let pos = cdOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > buf.length) break;
    const sig = readUint32LE(buf, pos);
    if (sig !== 0x02014b50) break; // Central directory entry signature

    const flags          = readUint16LE(buf, pos + 8);
    const compression    = readUint16LE(buf, pos + 10);
    const compressedSize = readUint32LE(buf, pos + 20);
    const uncompressedSize = readUint32LE(buf, pos + 24);
    const nameLen        = readUint16LE(buf, pos + 28);
    const extraLen       = readUint16LE(buf, pos + 30);
    const commentLen     = readUint16LE(buf, pos + 32);
    let   localOffset    = readUint32LE(buf, pos + 42);
    const isUtf8         = (flags & 0x0800) !== 0;

    const nameBytes = buf.slice(pos + 46, pos + 46 + nameLen);
    const name = decodeName(nameBytes, isUtf8);

    // Parse ZIP64 extra field if needed
    let actualCompressedSize = compressedSize;
    let actualUncompressedSize = uncompressedSize;
    let actualLocalOffset = localOffset;

    if (compressedSize === 0xFFFFFFFF || uncompressedSize === 0xFFFFFFFF || localOffset === 0xFFFFFFFF) {
      // Need ZIP64 extra
      const extraStart = pos + 46 + nameLen;
      const extraEnd = extraStart + extraLen;
      let ep = extraStart;
      while (ep + 4 <= extraEnd) {
        const headerId = readUint16LE(buf, ep);
        const dataSize = readUint16LE(buf, ep + 2);
        if (headerId === 0x0001) {
          let z = ep + 4;
          if (uncompressedSize === 0xFFFFFFFF && z + 8 <= extraEnd) {
            actualUncompressedSize = readUint64LE(buf, z); z += 8;
          }
          if (compressedSize === 0xFFFFFFFF && z + 8 <= extraEnd) {
            actualCompressedSize = readUint64LE(buf, z); z += 8;
          }
          if (localOffset === 0xFFFFFFFF && z + 8 <= extraEnd) {
            actualLocalOffset = readUint64LE(buf, z); z += 8;
          }
          break;
        }
        ep += 4 + dataSize;
      }
    }

    entries.push({
      name,
      compression,       // 0 = stored, 8 = deflated
      compressedSize: actualCompressedSize,
      uncompressedSize: actualUncompressedSize,
      localOffset: actualLocalOffset,
    });

    pos += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

/**
 * Get the actual data offset for an entry by reading its local file header.
 */
function getDataOffset(buf, entry) {
  const lhOffset = entry.localOffset;
  if (lhOffset + 30 > buf.length) throw new Error('Local header out of bounds');
  const sig = readUint32LE(buf, lhOffset);
  if (sig !== 0x04034b50) throw new Error('Bad local file header signature');
  const nameLen  = readUint16LE(buf, lhOffset + 26);
  const extraLen = readUint16LE(buf, lhOffset + 28);
  return lhOffset + 30 + nameLen + extraLen;
}

/**
 * Decompress a deflated entry using DecompressionStream.
 */
async function inflateDeflate(compressedData) {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  writer.write(compressedData);
  writer.close();

  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  // Concatenate
  let totalLen = 0;
  for (const c of chunks) totalLen += c.length;
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}

/**
 * Extract the raw bytes for a given entry from the buffer.
 */
async function extractEntry(buf, entry) {
  const dataOffset = getDataOffset(buf, entry);
  const compressedData = buf.slice(dataOffset, dataOffset + entry.compressedSize);

  if (entry.compression === 0) {
    // Stored
    return compressedData;
  } else if (entry.compression === 8) {
    // Deflated
    return await inflateDeflate(compressedData);
  } else {
    throw new Error(`Unsupported compression method: ${entry.compression}`);
  }
}

/**
 * Given entry list, return only image files sorted alphabetically.
 */
function filterAndSortImages(entries) {
  return entries
    .filter(e => {
      if (e.name.endsWith('/')) return false; // directory
      const parts = e.name.split('.');
      const ext = parts[parts.length - 1].toLowerCase();
      return IMAGE_EXTENSIONS.has(ext);
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

/**
 * Get mime type from file extension.
 */
function getMimeType(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const mimes = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
    bmp: 'image/bmp', tiff: 'image/tiff', tif: 'image/tiff',
  };
  return mimes[ext] || 'image/jpeg';
}

// ─── FRAGMENT PARSING ────────────────────────────────────────────────────────

function parseFragment(hash) {
  // hash is like "#cbz" or "#cbz&page=3" or "?src=...#cbz&page=3"
  let page = 1;
  // Remove leading #
  const frag = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = frag.split('&');
  for (const p of params) {
    if (p.startsWith('page=')) {
      const n = parseInt(p.slice(5), 10);
      if (!isNaN(n) && n >= 1) page = n;
    }
  }
  return { page };
}

// ─── UI STATE ────────────────────────────────────────────────────────────────

let state = {
  buf: null,
  entries: [],       // all image entries sorted
  currentPage: 1,
  totalPages: 0,
  srcUrl: '',
  loading: false,
  blobUrls: {},      // cache: page index -> blob URL
};

// ─── UI HELPERS ──────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

function setStatus(msg) {
  $('status-text').textContent = msg;
}

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
  $('page-input').value = state.currentPage;
  $('page-input').max = state.totalPages;
}

// ─── PAGE DISPLAY ────────────────────────────────────────────────────────────

async function displayPage(pageNum) {
  if (pageNum < 1 || pageNum > state.totalPages) return;
  state.currentPage = pageNum;

  const img = $('comic-image');
  const spinner = $('page-spinner');

  img.classList.add('loading');
  spinner.classList.remove('hidden');

  try {
    let blobUrl = state.blobUrls[pageNum];
    if (!blobUrl) {
      const entry = state.entries[pageNum - 1];
      setStatus(`Extracting page ${pageNum}…`);
      const data = await extractEntry(state.buf, entry);
      const mime = getMimeType(entry.name);
      const blob = new Blob([data], { type: mime });
      blobUrl = URL.createObjectURL(blob);
      state.blobUrls[pageNum] = blobUrl;
    }

    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = blobUrl;
    });

    updatePageUI();

    // Update fragment in viewer URL (doesn't affect the src param)
    const viewerUrl = new URL(window.location.href);
    viewerUrl.hash = `cbz&page=${pageNum}`;
    history.replaceState(null, '', viewerUrl.toString());

    // Prefetch adjacent pages quietly
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
    const data = await extractEntry(state.buf, entry);
    const mime = getMimeType(entry.name);
    const blob = new Blob([data], { type: mime });
    state.blobUrls[pageNum] = URL.createObjectURL(blob);
  } catch (e) {
    // Silent prefetch failure is fine
  }
}

// ─── MAIN LOAD ───────────────────────────────────────────────────────────────

async function loadCbz(url, startPage) {
  showLoading('Fetching file…');

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      setStatus(`Downloading… (${(parseInt(contentLength) / 1024 / 1024).toFixed(1)} MB)`);
    } else {
      setStatus('Downloading…');
    }

    const arrayBuf = await response.arrayBuffer();
    state.buf = new Uint8Array(arrayBuf);
    setStatus('Parsing ZIP…');

    const allEntries = parseCentralDirectory(state.buf);
    state.entries = filterAndSortImages(allEntries);
    state.totalPages = state.entries.length;

    if (state.totalPages === 0) {
      throw new Error('No image files found in this CBZ archive.');
    }

    // Update title
    try {
      const srcUrl = new URL(url);
      const fileName = decodeURIComponent(srcUrl.pathname.split('/').pop()) || 'Comic';
      document.title = fileName.replace(/\.cbz$/i, '') + ' — CBZ Viewer';
      $('comic-title').textContent = fileName.replace(/\.cbz$/i, '');
    } catch (e) {}

    showViewer();
    updatePageUI();

    const page = Math.max(1, Math.min(startPage, state.totalPages));
    await displayPage(page);

  } catch (err) {
    console.error('Load error:', err);
    showError(err.message || 'Failed to load the CBZ file.');
  }
}

// ─── NAVIGATION ──────────────────────────────────────────────────────────────

function goToPage(n) {
  const page = Math.max(1, Math.min(n, state.totalPages));
  if (page !== state.currentPage) {
    displayPage(page);
  }
}

// ─── KEYBOARD / INPUT ────────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  switch (e.key) {
    case 'ArrowRight':
    case 'ArrowDown':
    case ' ':
    case 'PageDown':
      e.preventDefault();
      goToPage(state.currentPage + 1);
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
    case 'PageUp':
      e.preventDefault();
      goToPage(state.currentPage - 1);
      break;
    case 'Home':
      goToPage(1);
      break;
    case 'End':
      goToPage(state.totalPages);
      break;
  }
});

$('prev-btn').addEventListener('click', () => goToPage(state.currentPage - 1));
$('next-btn').addEventListener('click', () => goToPage(state.currentPage + 1));

$('page-input').addEventListener('change', e => {
  const n = parseInt(e.target.value, 10);
  if (!isNaN(n)) goToPage(n);
});

$('page-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const n = parseInt(e.target.value, 10);
    if (!isNaN(n)) goToPage(n);
    e.target.blur();
  }
});

// Click left/right halves of image to navigate
$('comic-image').addEventListener('click', e => {
  const rect = e.target.getBoundingClientRect();
  const x = e.clientX - rect.left;
  if (x < rect.width / 2) {
    goToPage(state.currentPage - 1);
  } else {
    goToPage(state.currentPage + 1);
  }
});

// ─── INIT ─────────────────────────────────────────────────────────────────────

(function init() {
  const params = new URLSearchParams(window.location.search);
  const src = params.get('src');

  if (!src) {
    showError('No CBZ source URL provided. Open a .cbz file to use this viewer.');
    return;
  }

  state.srcUrl = src;

  // Parse page from both the viewer's own fragment AND the original URL's fragment
  let startPage = 1;
  const viewerHash = window.location.hash;
  if (viewerHash) {
    startPage = parseFragment(viewerHash).page;
  } else {
    // Try extracting page from original URL fragment
    try {
      const srcParsed = new URL(src);
      if (srcParsed.hash) {
        startPage = parseFragment(srcParsed.hash).page;
      }
    } catch (e) {}
  }

  loadCbz(src, startPage);
})();
