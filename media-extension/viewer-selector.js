'use strict';
// ── Selector module ──────────────────────────────────────────────────────────
//
// Owns all selector-pane state: the current directory, the selected file, the
// directory listing, and the UI index of the highlighted item.  Nothing outside
// this module should write to these — callers read via the getter properties and
// drive changes through the public methods.
//
// Calls into globals that remain in viewer.js for now (will migrate in later
// refactor passes): showMediaFile, persistState, applyUiState, setFocusMode,
// toggleZoom, showScreen, mediaType, toProxyDir, toProxyQueueDir, toProxyThumb,
// fmtSize, _bcPost, _collectAndQueueDir,
// ui, fileListEl, dirPathEl, btnRecursive, btnHidden, btnSort.

class Selector {

  // ── Private fields ──────────────────────────────────────────────────────────

  #dir     = null;   // current directory (file:// URL)
  #file    = null;   // selected filename within #dir (or null)
  #listing = [];     // sorted/filtered entry objects from latest fetch
  #selIdx  = -1;     // index of selected item (-1 = none)
  #activeIdx  = -1;  // index of active item (-1 = none)
  #items   = [];     // flat array of .file-item elements, parallel to #listing
  #listenersWired = false;

  // Items are grouped into fixed-height .item-chunk containers so that
  // content-visibility: auto on each chunk lets Gecko skip building frame trees
  // for the ~900 off-screen chunks in a large directory.
  static #CHUNK_SIZE = 100;

  // ── Listing utilities ───────────────────────────────────────────────────────

  #isSelectable(item) {
    if (item.t === 'd') return true;
    if (item.r === 0)   return false;
    return mediaType(item.u) !== 'unknown';
  }

  #sortItems(items) {
    const dirs  = items.filter(i => i.t === 'd');
    const files = items.filter(i => i.t !== 'd');
    const cmp = (a, b) => {
      if (ui.sortBy === 'mtime') return (b.m || 0) - (a.m || 0);
      if (ui.sortBy === 'size')  return (b.s || 0) - (a.s || 0);
      return a.u.toLowerCase().localeCompare(b.u.toLowerCase());
    };
    dirs.sort(cmp);
    files.sort(cmp);
    return dirs.concat(files);
  }

  #filterItems(items) {
    if (ui.showHidden) return items;
    return items.filter(i => i.u.replace(/\/$/, '').split('/').pop().charAt(0) !== '.');
  }

  displayableFiles() {
    return this.#listing.filter(i => this.#isSelectable(i) && i.t !== 'd');
  }

  // ── Directory loading ───────────────────────────────────────────────────────

  async loadDir(dirUrl, push) {
    showScreen('loading');

    const proxyUrl = toProxyDir(dirUrl, ui.recursive);
    let data;
    try {
      const resp = await fetch(proxyUrl);
      if (!resp.ok) throw new Error('Server returned HTTP ' + resp.status);
      data = await resp.json();
    } catch (err) {
      document.getElementById('error-message').textContent = String(err);
      showScreen('error');
      return;
    }

    this.#listing = this.#sortItems(this.#filterItems(data.files || []));
    this.#dir     = dirUrl;

    if (this.#file && !this.#listing.some(i => i.u === this.#file)) {
      this.#file = null;
    }

    persistState(push, dirUrl, this.#file);
    this.renderSelector();
    if (ui.thumbnails) fetch(toProxyQueueDir(dirUrl)).catch(() => {});
    this.updateDirPath();
    applyUiState();
    showScreen('viewer');

    if (this.#file) {
      const selIdx = this.#listing.findIndex(i => i.u === this.#file);
      if (selIdx >= 0) this.markActive(selIdx, false);
      showMediaFile(this.#file);
    } else {
      const firstFile = this.#listing.findIndex(i => this.#isSelectable(i) && i.t !== 'd');
      if (firstFile >= 0) this.selectItem(firstFile, false);
      else if (this.#listing.length > 0) this.selectItem(0, false);
    }
  }

  // ── Selector rendering ──────────────────────────────────────────────────────

  // Wire delegated event listeners on fileListEl once.  click/dblclick bubble
  // naturally; load/error on <img> do not, so those use capture.
  #wireListeners() {
    if (this.#listenersWired) return;
    this.#listenersWired = true;

    fileListEl.addEventListener('click', (e) => {
      const el = e.target.closest('.file-item');
      if (!el || el.classList.contains('dimmed')) return;
      setFocusMode('list');
      this.selectItem(parseInt(el.dataset.idx, 10), false);
    });

    fileListEl.addEventListener('dblclick', (e) => {
      const el = e.target.closest('.file-item');
      if (!el || el.classList.contains('dimmed')) return;
      this.openItem(parseInt(el.dataset.idx, 10));
    });

    fileListEl.addEventListener('load', (e) => {
      const t = e.target;
      if (t.tagName !== 'IMG' || !t.classList.contains('thumb-img')) return;
      t.classList.remove('thumb-loading');
    }, true);

    fileListEl.addEventListener('error', (e) => {
      const t = e.target;
      if (t.tagName !== 'IMG' || !t.classList.contains('thumb-img')) return;
      t.classList.remove('thumb-loading');
      const item = t.closest('.file-item');
      if (item) item.classList.add('thumb-error');
    }, true);
  }

  renderSelector() {
    this.#wireListeners();
    fileListEl.innerHTML = '';
    this.#items  = [];
    this.#selIdx = -1;
    fileListEl.classList.toggle('thumbnails', ui.thumbnails);

    let chunk = null;
    this.#listing.forEach((item, idx) => {
      if (idx % Selector.#CHUNK_SIZE === 0) {
        chunk = document.createElement('div');
        chunk.className = 'item-chunk';
        fileListEl.appendChild(chunk);
      }

      const el = document.createElement('div');
      el.className = 'file-item';
      el.dataset.idx = String(idx);

      const mtype = mediaType(item.u);
      if (!this.#isSelectable(item)) el.classList.add('dimmed');
      if (item.t === 'd')            el.classList.add('is-dir');
      if (mtype === 'video')         el.classList.add('is-video');
      if (mtype === 'audio')         el.classList.add('is-audio');

      this.#renderItem(el, item);
      this.#items.push(el);
      chunk.appendChild(el);
    });

    // Last chunk may be smaller than CHUNK_SIZE; tell CSS so its height is exact.
    const tail = this.#listing.length % Selector.#CHUNK_SIZE;
    if (tail !== 0 && chunk) chunk.style.setProperty('--chunk-size', tail);
  }

  // Renders all child elements for a file-item in a single pass.  The same DOM
  // serves both list and thumbnail modes; viewer.css toggles visibility via the
  // .thumbnails class on the parent list.  load/error events are handled by
  // delegated capture listeners on fileListEl rather than per-element.
  #renderItem(el, item) {
    const type = mediaType(item.u);

    const iconEl = document.createElement('span');
    iconEl.className = 'file-icon';
    iconEl.textContent = item.t === 'd' ? '>' : type === 'video' ? '▶' : type === 'audio' ? '♪' : ' ';
    el.appendChild(iconEl);

    // Thumbnail image — created for every non-directory, non-unknown item so
    // that switching to thumbnail mode needs only a class toggle on the list.
    // loading="lazy" keeps the image unfetched while display:none in list mode.
    // has-thumb marks items that carry a thumbnail slot (avoids :has() in CSS).
    if (item.t !== 'd' && type !== 'unknown') {
      el.classList.add('has-thumb');
      const imgEl = document.createElement('img');
      imgEl.className = 'thumb-img thumb-loading';
      imgEl.src       = toProxyThumb(this.#dir.replace(/\/$/, '') + '/' + item.u);
      imgEl.alt       = '';
      imgEl.draggable = false;
      imgEl.loading   = 'lazy';
      el.appendChild(imgEl);
    }

    const nameEl = document.createElement('span');
    nameEl.className = 'file-name';
    nameEl.textContent = item.u;
    el.appendChild(nameEl);

    const metaEl = document.createElement('span');
    metaEl.className = 'file-meta';
    if (item.s !== undefined) metaEl.textContent = fmtSize(item.s);
    el.appendChild(metaEl);
  }

  // ── Item selection ──────────────────────────────────────────────────────────

  selectItem(idx, scroll) {
    if (idx >= this.#listing.length) return;
    const prev = fileListEl.querySelector('.file-item.selected');
    if (prev) prev.classList.remove('selected');
    this.#selIdx = idx;
    if (idx < 0) return;
    const el = this.#items[idx];
    if (!el) return;
    el.classList.add('selected');
    if (scroll) el.scrollIntoView({ block: 'center' });
  }

  markActive(idx, scroll) {
    if (idx < 0 || idx >= this.#listing.length) return;
    const prev = fileListEl.querySelector('.file-item.active');
    if (prev) prev.classList.remove('active');
    this.#activeIdx = idx;
    const el = this.#items[idx];
    if (!el) return;
    el.classList.add('active');
    if (scroll) el.scrollIntoView({ block: 'center' });
  }

  // ── Item opening / file navigation ─────────────────────────────────────────

  openItem(idx) {
    if (idx < 0 || idx >= this.#listing.length) return;
    const item = this.#listing[idx];
    if (!this.#isSelectable(item)) return;

    if (item.t === 'd') {
      this.#file = null;
      this.loadDir(this.#dir.replace(/\/$/, '') + '/' + item.u.replace(/\/$/, ''), true);
      setFocusMode('list');
    } else {
      this.#file = item.u;
      persistState(false);
      this.markActive(idx);
      this.selectItem(-1);
      showMediaFile(item.u);
      setFocusMode('viewer');
    }
  }

  nextFile() {
    const files = this.displayableFiles();
    if (files.length === 0) return;
    const idx  = files.findIndex(i => i.u === this.#file);
    const next = files[(idx + 1) % files.length];
    this.markActive(this.#listing.findIndex(i => i.u === next.u), true);
    this.#file = next.u;
    persistState(false);
    showMediaFile(next.u);
  }

  prevFile() {
    const files = this.displayableFiles();
    if (files.length === 0) return;
    const idx  = files.findIndex(i => i.u === this.#file);
    const prev = files[(idx - 1 + files.length) % files.length];
    this.markActive(this.#listing.findIndex(i => i.u === prev.u), true);
    this.#file = prev.u;
    persistState(false);
    showMediaFile(prev.u);
  }

  goToParent() {
    const path = this.#dir.replace(/^file:\/\//, '').replace(/\/$/, '');
    this.#file = null;
    this.loadDir('file://' + (path.substring(0, path.lastIndexOf('/')) || '/'), true);
  }

  // ── Keyboard navigation helpers ─────────────────────────────────────────────

  moveSelectionBy(delta) {
    if (this.#listing.length === 0) return;
    const start = this.#selIdx < 0
      ? (this.#activeIdx < 0 ? (delta > 0 ? -1 : this.#listing.length) : this.#activeIdx)
      : this.#selIdx;
    const step  = delta > 0 ? 1 : -1;
    const count = Math.abs(delta);
    let cur = start;
    for (let moved = 0; moved < count; ) {
      const next = cur + step;
      if (next < 0 || next >= this.#listing.length) break;
      cur = next;
      if (this.#isSelectable(this.#listing[cur])) moved++;
    }
    if (cur !== start && cur >= 0 && cur < this.#listing.length) this.selectItem(cur, true);
  }

  jumpToEdge(dir) {
    if (dir > 0) {
      for (let i = 0; i < this.#listing.length; i++) {
        if (this.#isSelectable(this.#listing[i])) { this.selectItem(i, true); return; }
      }
    } else {
      for (let i = this.#listing.length - 1; i >= 0; i--) {
        if (this.#isSelectable(this.#listing[i])) { this.selectItem(i, true); return; }
      }
    }
  }

  // ── Toggle operations ───────────────────────────────────────────────────────

  toggleThumbnails() {
    ui.thumbnails = !ui.thumbnails;
    persistState(false);
    fileListEl.classList.toggle('thumbnails', ui.thumbnails);
    if (ui.thumbnails && this.#dir) fetch(toProxyQueueDir(this.#dir)).catch(() => {});
    const el = this.#items[this.#selIdx];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  toggleRecursive() {
    ui.recursive = !ui.recursive;
    if (btnRecursive) btnRecursive.classList.toggle('active', ui.recursive);
    persistState(false);
    if (this.#dir) this.loadDir(this.#dir, false);
  }

  toggleHidden() {
    ui.showHidden = !ui.showHidden;
    if (btnHidden) btnHidden.classList.toggle('active', ui.showHidden);
    persistState(false);
    if (this.#dir) this.loadDir(this.#dir, false);
  }

  cycleSortBy() {
    const orders = ['name', 'mtime', 'size'];
    ui.sortBy = orders[(orders.indexOf(ui.sortBy) + 1) % orders.length];
    persistState(false);
    this.#listing = this.#sortItems(this.#listing);
    this.renderSelector();
    const labels = { name: 'NAME', mtime: 'DATE', size: 'SIZE' };
    if (btnSort) btnSort.textContent = labels[ui.sortBy] || 'NAME';
    if (this.#file) {
      const i = this.#listing.findIndex(x => x.u === this.#file);
      if (i >= 0) this.markActive(i, true);
    }
  }

  // ── Info / path display ─────────────────────────────────────────────────────

  updateDirPath() {
    if (!dirPathEl || !this.#dir) return;
    const path = this.#dir.replace(/^file:\/\//, '');
    dirPathEl.textContent = path;
    dirPathEl.title       = path;
    document.title        = path + ' — Media Viewer';
  }

  // ── Key handler ─────────────────────────────────────────────────────────────

  handleKey(e, key, ctrl) {
    if (!ctrl && key === 'R') {
      if (this.#dir) this.loadDir(this.#dir, false);
      return;
    }
    if (ctrl) return;
    switch (key) {
      case 'ArrowDown':  e.preventDefault(); this.moveSelectionBy(1);   break;
      case 'ArrowUp':    e.preventDefault(); this.moveSelectionBy(-1);  break;
      case 'j':                              this.moveSelectionBy(1);   break;
      case 'k':                              this.moveSelectionBy(-1);  break;
      case 'PageDown':   e.preventDefault(); this.moveSelectionBy(10);  break;
      case 'PageUp':     e.preventDefault(); this.moveSelectionBy(-10); break;
      case 'Home':       e.preventDefault(); this.jumpToEdge(1);        break;
      case 'End':        e.preventDefault(); this.jumpToEdge(-1);       break;
      case 'Enter':      e.preventDefault();
        if (this.#selIdx >= 0) this.openItem(this.#selIdx); else setFocusMode('viewer');
        break;
      case ' ':          e.preventDefault();
        if (this.#selIdx >= 0) this.openItem(this.#selIdx);
        break;
      case 'ArrowRight': e.preventDefault();
        if (this.#selIdx >= 0 && this.#listing[this.#selIdx]?.t === 'd') {
          this.openItem(this.#selIdx);
        } else {
          this.nextFile();
        }
        break;
      case 'ArrowLeft':
      case 'Backspace':
      case 'u':          e.preventDefault(); this.goToParent(); break;
      case 'n':          this.nextFile(); break;
      case 'b':          this.prevFile(); break;
      case 'q':          this.handleQueueKey(); break;
      case 's':          this.cycleSortBy(); break;
      case 'z':          toggleZoom(); break;
    }
  }

  // ── Queue key handling ──────────────────────────────────────────────────────

  // Called when the user presses 'q' with selector focus.
  // On a file: add it to the appropriate queue and advance to the next item.
  // On a directory: collect all queueable files (respecting CD/Disc subdirs)
  // and add them without advancing the cursor.
  handleQueueKey() {
    if (this.#selIdx < 0 || !this.#listing[this.#selIdx]) return;
    const item = this.#listing[this.#selIdx];
    if (item.t === 'd') {
      _collectAndQueueDir(this.#dir.replace(/\/$/, '') + '/' + item.u).catch(() => {});
    } else {
      const mt = mediaType(item.u);
      if (mt !== 'audio' && mt !== 'video') return;
      _bcPost('media-queue', {
        cmd: 'q-add', type: mt,
        items: [{ dir: this.#dir, file: item.u }]
      });
      this.nextFile();
    }
  }

  // ── Initialisation helpers ──────────────────────────────────────────────────

  // Set dir + file from URL params / history state without triggering a load.
  // Call before loadDir() when restoring history state.
  setFromHistory(dir, file) {
    this.#dir  = dir  || null;
    this.#file = file || null;
  }

  // ── Public getters ──────────────────────────────────────────────────────────

  get currentDir()  { return this.#dir;       }
  get currentFile() { return this.#file;      }
  get listing()     { return this.#listing;   }
  get activeIdx()   { return this.#activeIdx; }
  get selectedIdx() { return this.#selIdx;    }
}

const selector = new Selector();
