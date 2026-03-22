// viewer.js — CBZ parser and comic reader
'use strict';

// ─── BINARY HELPERS ──────────────────────────────────────────────────────────

function readUint16LE(buf, offset) {
  return buf[offset] | (buf[offset + 1] << 8);
}
function readUint32LE(buf, offset) {
  return (buf[offset] | (buf[offset+1]<<8) | (buf[offset+2]<<16) | (buf[offset+3]<<24)) >>> 0;
}
function readUint64LE(buf, offset) {
  const lo = readUint32LE(buf, offset);
  const hi = readUint32LE(buf, offset + 4);
  return hi * 0x100000000 + lo;
}

// ─── FILE ACCESSORS ───────────────────────────────────────────────────────────

class BlobAccessor {
  constructor(blob) { this._blob = blob; this.size = blob.size; }
  async read(offset, length) {
    return new Uint8Array(await this._blob.slice(offset, offset+length).arrayBuffer());
  }
}

class HttpAccessor {
  constructor(url, size, blob) { this._url = url; this._blob = blob; this.size = size; }
  static async create(url) {
    let size = null, rangeOk = false;
    try {
      const head = await fetch(url, { method: 'HEAD' });
      if (head.ok) {
        const cl = head.headers.get('content-length');
        if (cl) size = parseInt(cl, 10);
        const ar = head.headers.get('accept-ranges');
        rangeOk = !!(ar && ar.toLowerCase() !== 'none');
      }
    } catch (_) {}
    if (rangeOk && size !== null) return new HttpAccessor(url, size, null);
    setStatus('Downloading…');
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    const cl = resp.headers.get('content-length');
    if (cl) setStatus(`Downloading… (${(parseInt(cl)/1024/1024).toFixed(1)} MB)`);
    const blob = await resp.blob();
    return new HttpAccessor(url, blob.size, blob);
  }
  async read(offset, length) {
    if (this._blob)
      return new Uint8Array(await this._blob.slice(offset, offset+length).arrayBuffer());
    const resp = await fetch(this._url, { headers: { 'Range': `bytes=${offset}-${offset+length-1}` } });
    if (resp.status !== 206 && !resp.ok) throw new Error(`Range request failed: HTTP ${resp.status}`);
    return new Uint8Array(await resp.arrayBuffer());
  }
}

// ─── PROXY URL ────────────────────────────────────────────────────────────────

const PROXY_PREFIX = 'http://127.7.203.66/cbz-file/';

function fileUrlToProxyUrl(fileUrl) {
  const pathname = new URL(fileUrl).pathname;
  return PROXY_PREFIX + pathname.slice(1);
}

// ─── ZIP PARSING ──────────────────────────────────────────────────────────────

const EOCD_MAX_TAIL = 22 + 65535;

async function findAndParseEOCD(accessor) {
  const tailSize   = Math.min(accessor.size, EOCD_MAX_TAIL);
  const tailOffset = accessor.size - tailSize;
  const tail       = await accessor.read(tailOffset, tailSize);

  let eocdPos = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i]===0x50 && tail[i+1]===0x4B && tail[i+2]===0x05 && tail[i+3]===0x06) {
      eocdPos = i; break;
    }
  }
  if (eocdPos < 0) throw new Error('Not a valid ZIP file: EOCD not found');

  const eocdAbsolute = tailOffset + eocdPos;
  let cdOffset, cdSize, totalEntries;

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
  const cd = await accessor.read(cdOffset, cdSize);
  const entries = [];
  let pos = 0;
  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > cd.length) break;
    if (readUint32LE(cd, pos) !== 0x02014b50) break;
    const flags           = readUint16LE(cd, pos + 8);
    const compression     = readUint16LE(cd, pos + 10);
    let   compressedSize  = readUint32LE(cd, pos + 20);
    let   uncompressedSize= readUint32LE(cd, pos + 24);
    const nameLen         = readUint16LE(cd, pos + 28);
    const extraLen        = readUint16LE(cd, pos + 30);
    const commentLen      = readUint16LE(cd, pos + 32);
    let   localOffset     = readUint32LE(cd, pos + 42);
    const isUtf8          = (flags & 0x0800) !== 0;
    const name = decodeName(cd.slice(pos + 46, pos + 46 + nameLen), isUtf8);
    if (compressedSize===0xFFFFFFFF || uncompressedSize===0xFFFFFFFF || localOffset===0xFFFFFFFF) {
      let ep = pos + 46 + nameLen, end = ep + extraLen;
      while (ep + 4 <= end) {
        const hid = readUint16LE(cd, ep), dsz = readUint16LE(cd, ep+2);
        if (hid === 0x0001) {
          let z = ep + 4;
          if (uncompressedSize===0xFFFFFFFF && z+8<=end) { uncompressedSize=readUint64LE(cd,z); z+=8; }
          if (compressedSize===0xFFFFFFFF   && z+8<=end) { compressedSize  =readUint64LE(cd,z); z+=8; }
          if (localOffset===0xFFFFFFFF      && z+8<=end) { localOffset     =readUint64LE(cd,z); z+=8; }
          break;
        }
        ep += 4 + dsz;
      }
    }
    entries.push({ name, compression, compressedSize, uncompressedSize, localOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function extractEntry(accessor, entry) {
  const lh = await accessor.read(entry.localOffset, 30);
  if (readUint32LE(lh, 0) !== 0x04034b50) throw new Error('Bad local file header signature');
  const dataOffset = entry.localOffset + 30 + readUint16LE(lh,26) + readUint16LE(lh,28);
  const compressed = await accessor.read(dataOffset, entry.compressedSize);
  if (entry.compression === 0) return compressed;
  if (entry.compression === 8) return inflateDeflate(compressed);
  throw new Error(`Unsupported compression: ${entry.compression}`);
}

async function inflateDeflate(data) {
  const ds = new DecompressionStream('deflate-raw');
  const w = ds.writable.getWriter(), r = ds.readable.getReader();
  w.write(data); w.close();
  const chunks = [];
  for (;;) { const {done,value} = await r.read(); if (done) break; chunks.push(value); }
  let len=0; for (const c of chunks) len+=c.length;
  const out = new Uint8Array(len); let off=0;
  for (const c of chunks) { out.set(c,off); off+=c.length; }
  return out;
}

// ─── IMAGE FILTERING ─────────────────────────────────────────────────────────

const IMAGE_EXTENSIONS = new Set(['jpg','jpeg','png','gif','webp','avif','bmp','tiff','tif']);

function filterAndSortImages(entries) {
  return entries
    .filter(e => !e.name.endsWith('/') && IMAGE_EXTENSIONS.has(e.name.split('.').pop().toLowerCase()))
    .sort((a,b) => a.name.localeCompare(b.name, undefined, {numeric:true, sensitivity:'base'}));
}

function getMimeType(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  return ({jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',gif:'image/gif',
           webp:'image/webp',avif:'image/avif',bmp:'image/bmp',tiff:'image/tiff',tif:'image/tiff'})[ext]
         || 'image/jpeg';
}

// ─── FRAGMENT PARSING ─────────────────────────────────────────────────────────

function parseFragment(hash) {
  const frag = hash.startsWith('#') ? hash.slice(1) : hash;
  let page = 1;
  for (const p of frag.split('&')) {
    if (p.startsWith('page=')) { const n=parseInt(p.slice(5),10); if (!isNaN(n)&&n>=1) page=n; }
  }
  return { page };
}

// ─── PERSISTENT STORAGE (localStorage, no chrome.* needed) ───────────────────
// Stores { page, rtl, twoPage } per src URL. Uses localStorage which is
// available in extension pages without any chrome.* API calls.

const LS_KEY = 'cbz_viewer_state';

function loadStoredState(srcUrl) {
  try {
    const all = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    return all[srcUrl] || null;
  } catch (_) { return null; }
}

function saveStoredState(srcUrl, page, rtl, twoPage) {
  if (!srcUrl || srcUrl.startsWith('local:')) return;
  try {
    const all = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    all[srcUrl] = { page, rtl: rtl?1:0, two: twoPage?1:0 };
    // Prune to most recent 500 entries to avoid unbounded growth
    const keys = Object.keys(all);
    if (keys.length > 500) delete all[keys[0]];
    localStorage.setItem(LS_KEY, JSON.stringify(all));
  } catch (_) {}
}

// ─── UI STATE ─────────────────────────────────────────────────────────────────

let state = {
  accessor:    null,
  entries:     [],
  currentPage: 1,   // first page of current spread; 0 = blank+page1 in two-page mode
  totalPages:  0,
  srcUrl:      '',
  blobUrls:    {},
  extracting:  {},
  rtl:         false,
  twoPage:     false,
};

// ─── UI HELPERS ───────────────────────────────────────────────────────────────

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

function setTitle(name) {
  const display = name.replace(/\.cbz$/i, '');
  document.title = display + ' \u2014 CBZ Viewer';
  $('comic-title').textContent = display;
}

function updatePageUI() {
  const p    = state.currentPage;
  const isTwo = state.twoPage && state.totalPages > 1;
  const [leftP, rightP] = pagesForDisplay(p);
  // Show "X–Y of Z" in two-page mode when both pages are present
  const secondVisible = isTwo && rightP !== null;
  // Display the page range in the input label area
  // We put the second page number in the page-second span
  $('page-input').value = p;
  $('page-input').min   = state.twoPage ? '0' : '1';
  $('page-input').max   = state.totalPages;
  $('page-total').textContent = state.totalPages;
  const secondSpan = $('page-second');
  if (secondSpan) {
    secondSpan.textContent = secondVisible ? '–' + rightP : '';
    secondSpan.style.display = secondVisible ? '' : 'none';
  }
  $('prev-btn').disabled = p <= (state.twoPage ? 0 : 1);
  $('next-btn').disabled = isTwo
    ? (rightP === null && p >= state.totalPages) || p >= state.totalPages
    : p >= state.totalPages;
  $('btn-two').classList.toggle('active', state.twoPage);
  $('btn-rtl').classList.toggle('active', state.rtl);
}

function updateUrl() {
  const u = new URL(window.location.href);
  u.searchParams.set('page', state.currentPage);
  u.searchParams.set('rtl',  state.rtl    ? '1' : '0');
  u.searchParams.set('two',  state.twoPage? '1' : '0');
  history.replaceState(null, '', u.toString());
}

// ─── PAGE EXTRACTION ─────────────────────────────────────────────────────────

async function getPageBlobUrl(pageNum, updateStatus) {
  if (state.blobUrls[pageNum]) return state.blobUrls[pageNum];
  if (!state.extracting[pageNum]) {
    state.extracting[pageNum] = (async () => {
      const entry = state.entries[pageNum - 1];
      if (updateStatus) setStatus(`Extracting page ${pageNum}…`);
      const data = await extractEntry(state.accessor, entry);
      const url  = URL.createObjectURL(new Blob([data], {type: getMimeType(entry.name)}));
      state.blobUrls[pageNum] = url;
      delete state.extracting[pageNum];
      return url;
    })();
  }
  return state.extracting[pageNum];
}

// ─── DISPLAY ─────────────────────────────────────────────────────────────────
// currentPage is the first page of the current spread.
// In two-page mode p=0 means [blank, page1] (or [page1, blank] in RTL).
// p=1 means [page1, page2], p=2 means [page2, page3], etc.
// There is no separate offset — the page number itself encodes the pairing.

function pagesForDisplay(p) {
  // Returns [leftSlot, rightSlot] where null means blank
  if (!state.twoPage || state.totalPages <= 1) return [p, null];
  const a = (p >= 1 && p <= state.totalPages) ? p     : null;
  const b = (p+1 >= 1 && p+1 <= state.totalPages) ? p+1 : null;
  // RTL: earlier page on right, later on left
  return state.rtl ? [b, a] : [a, b];
}

async function displayPage(pageNum) {
  // In two-page mode pageNum can be 0 (blank + page1 spread)
  if (!state.twoPage && pageNum < 1) return;
  if (pageNum < 0 || pageNum > state.totalPages) return;
  state.currentPage = pageNum;
  setZoom('fit');

  const spinner = $('page-spinner');
  const spread  = $('page-spread');
  const slotA   = $('slot-a');
  const slotB   = $('slot-b');

  spinner.classList.remove('hidden');
  slotA.classList.add('loading');
  slotB.classList.add('loading');

  const [leftPage, rightPage] = pagesForDisplay(pageNum);

  // Update spread layout class
  spread.classList.toggle('two-page', rightPage !== null);

  // Helper: load an image slot, or blank it if page is null
  async function loadSlot(slot, page, primary) {
    if (page === null) {
      slot.removeAttribute('src');
      slot.style.display = '';   // visible blank
      slot.classList.remove('loading');
      return;
    }
    const url = await getPageBlobUrl(page, primary);
    await new Promise((res, rej) => { slot.onload=res; slot.onerror=rej; slot.src=url; });
    slot.style.display = '';
    slot.classList.remove('loading');
  }

  try {
    const twoVisible = state.twoPage && state.totalPages > 1;
    spread.classList.toggle('two-page', twoVisible && (leftPage !== null || rightPage !== null));

    if (twoVisible) {
      // Show both slots (possibly one blank)
      slotB.style.display = '';
      await Promise.all([
        loadSlot(slotA, leftPage,  true),
        loadSlot(slotB, rightPage, false),
      ]);
    } else {
      slotB.style.display = 'none';
      slotB.removeAttribute('src');
      await loadSlot(slotA, leftPage, true);
    }

    updatePageUI();
    updateUrl();
    saveStoredState(state.srcUrl, state.currentPage, state.rtl, state.twoPage);

    // Prefetch neighbours
    const step = state.twoPage ? 2 : 1;
    prefetchPage(pageNum + step);
    if (pageNum - step >= 1) prefetchPage(pageNum - step);

  } catch (err) {
    console.error('Page display error:', err);
    spinner.classList.add('hidden');
    slotA.classList.remove('loading');
    slotB.classList.remove('loading');
    showError(`Failed to load page ${pageNum}: ${err.message}`);
    return;
  } finally {
    spinner.classList.add('hidden');
    slotA.classList.remove('loading');
    slotB.classList.remove('loading');
  }
}

async function prefetchPage(pageNum) {
  if (pageNum < 1 || pageNum > state.totalPages) return;
  if (state.blobUrls[pageNum]) return;
  try { await getPageBlobUrl(pageNum, false); } catch (_) {}
}

// ─── ZOOM ─────────────────────────────────────────────────────────────────────

let zoomMode = 'fit';

function setZoom(mode) {
  zoomMode = mode;
  $('page-container').classList.toggle('zoom-full', mode === 'full');
  $('zone-zoom').style.cursor = mode === 'full' ? 'zoom-out' : 'zoom-in';
}

// ─── NAVIGATION ───────────────────────────────────────────────────────────────

function goNext(shift) {
  goToPage(state.currentPage + (state.twoPage && !shift ? 2 : 1));
}

function goPrev(shift) {
  goToPage(state.currentPage - (state.twoPage && !shift ? 2 : 1));
}

function goToPage(n) {
  const min  = state.twoPage ? 0 : 1;
  const page = Math.max(min, Math.min(n, state.totalPages));
  if (page !== state.currentPage) displayPage(page);
}

// ─── MODE TOGGLES ─────────────────────────────────────────────────────────────

function setModes(rtl, twoPage) {
  const wasTwo = state.twoPage;
  state.rtl     = rtl;
  state.twoPage = twoPage;

  if (!wasTwo && twoPage) {
    // Entering two-page: decrement so current page becomes second of spread.
    // e.g. on page 5 → now on page 4, showing (4, 5). Minimum is 0.
    state.currentPage = Math.max(0, state.currentPage - 1);
  } else if (wasTwo && !twoPage) {
    // Leaving two-page: increment so we land on the second page (the one
    // the reader was looking at as the "main" page in the spread).
    // e.g. was showing (4, 5) → now on page 5. Minimum is 1.
    state.currentPage = Math.max(1, state.currentPage + 1);
  }

  if (state.totalPages > 0) displayPage(state.currentPage);
}

// ─── EVENT LISTENERS ─────────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  const shift = e.shiftKey;
  switch (e.key) {
    // Navigation — RTL swaps left/right arrow semantics
    case 'ArrowRight':
      e.preventDefault();
      state.rtl ? goPrev(shift) : goNext(shift); break;
    case 'ArrowLeft':
      e.preventDefault();
      state.rtl ? goNext(shift) : goPrev(shift); break;
    case 'ArrowDown': case ' ': case 'PageDown':
      e.preventDefault(); goNext(shift); break;
    case 'ArrowUp': case 'PageUp':
      e.preventDefault(); goPrev(shift); break;
    case 'Home': goToPage(1); break;
    case 'End':  goToPage(state.totalPages); break;
    case 'z': case 'Z':
      setZoom(zoomMode === 'fit' ? 'full' : 'fit'); break;
    case 't': case 'T':
      setModes(state.rtl, !state.twoPage); break;
    case 'r': case 'R':
      setModes(!state.rtl, state.twoPage); break;
  }
});

$('prev-btn').addEventListener('click', () => state.rtl ? goNext(false) : goPrev(false));
$('next-btn').addEventListener('click', () => state.rtl ? goPrev(false) : goNext(false));

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

$('btn-two').addEventListener('click', () => setModes(state.rtl, !state.twoPage));
$('btn-rtl').addEventListener('click', () => setModes(!state.rtl, state.twoPage));

// Navigation zones — RTL swaps prev/next
$('zone-prev').addEventListener('click', e =>
  state.rtl ? goNext(e.shiftKey) : goPrev(e.shiftKey));
$('zone-next').addEventListener('click', e =>
  state.rtl ? goPrev(e.shiftKey) : goNext(e.shiftKey));
$('zone-zoom').addEventListener('click', () =>
  setZoom(zoomMode === 'fit' ? 'full' : 'fit'));

// ─── ACCESSOR FACTORY ─────────────────────────────────────────────────────────

async function createAccessor(url) {
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

// ─── LOADERS ──────────────────────────────────────────────────────────────────

async function loadWithAccessor(accessor, startPage) {
  showLoading('Opening…');
  try {
    state.accessor   = accessor;
    state.blobUrls   = {};
    state.extracting = {};
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

async function loadCbz(url, startPage) {
  showLoading('Opening…');
  try {
    let fetchUrl = url;
    if (url.startsWith('file://')) {
      fetchUrl = fileUrlToProxyUrl(url);
    }
    const accessor = await createAccessor(fetchUrl);
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

// ─── FILE PICKER ──────────────────────────────────────────────────────────────

function openFileFromPicker(file) {
  if (!file) return;
  state.srcUrl = 'local:' + file.name;
  setTitle(file.name);
  loadWithAccessor(new BlobAccessor(file), 1);
}

function wireFilePicker(btnId, inputId) {
  $(btnId).addEventListener('click', () => $(inputId).click());
  $(inputId).addEventListener('change', e => openFileFromPicker(e.target.files[0]));
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

(function init() {
  wireFilePicker('pick-btn',       'pick-file-input');
  wireFilePicker('error-open-btn', 'error-file-input');

  const params = new URLSearchParams(window.location.search);
  const src    = params.get('src');

  if (!src) {
    $('loading-screen').classList.add('hidden');
    $('pick-screen').classList.remove('hidden');
    return;
  }

  state.srcUrl = src;

  const nameParam = params.get('name');
  if (nameParam) setTitle(decodeURIComponent(nameParam));

  // Resolve starting page and modes:
  // Priority: URL params > localStorage > defaults
  const stored = loadStoredState(src);

  // Defaults from popup settings (stored in localStorage by popup.js)
  let defRtl = false, defTwo = false;
  try {
    const d = JSON.parse(localStorage.getItem('cbz_defaults') || '{}');
    defRtl = !!d.rtl;
    defTwo = !!d.twoPage;
  } catch (_) {}

  // Modes: URL params > per-comic storage > popup defaults
  state.rtl     = params.has('rtl') ? params.get('rtl') === '1'
                : stored             ? !!stored.rtl
                :                      defRtl;
  state.twoPage = params.has('two') ? params.get('two') === '1'
                : stored             ? !!stored.two
                :                      defTwo;

  // Page: URL param > stored > fragment > 1
  let startPage = 1;
  const pageParam = params.get('page');
  if (pageParam) {
    const n = parseInt(pageParam, 10);
    if (!isNaN(n) && n >= 1) startPage = n;
  } else if (stored && stored.page) {
    startPage = stored.page;
  } else {
    const hash = window.location.hash;
    if (hash) startPage = parseFragment(hash).page;
    else {
      try {
        const srcHash = new URL(src).hash;
        if (srcHash) startPage = parseFragment(srcHash).page;
      } catch (_) {}
    }
  }

  loadCbz(src, startPage);
})();
