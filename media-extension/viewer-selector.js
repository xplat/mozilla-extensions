'use strict';
// ── Selector module ──────────────────────────────────────────────────────────
//
// Owns selector-pane state: the current directory and the selected file.
// Extends FileList for all item-rendering, keyboard navigation, and selection
// semantics; overrides the hooks that are specific to this pane.
//
// Calls into globals that remain in viewer.js for now (will migrate in later
// refactor passes): showMediaFile, persistState, applyUiState, setFocusMode,
// showScreen, mediaType, toProxyDir, toProxyQueueDir, toProxyThumb,
// fmtSize, _bcPost, _collectAndQueueDir,
// ui, selectorPaneEl, dirPathEl, btnRecursive, btnHidden, btnSort.

class Selector extends FileList {

  // ── Private fields ──────────────────────────────────────────────────────────

  #dir  = null;   // current directory (file:// URL)
  #file = null;   // selected filename within #dir (or null)

  constructor() {
    super(ui, selectorPaneEl);
  }

  // ── FileList overrides ──────────────────────────────────────────────────────

  _isSelectable(item) {
    if (item.t === 'd') return true;
    if (item.r === 0)   return false;
    return mediaType(item.u) !== 'unknown';
  }

  _isViewable(item) {
    return this._isSelectable(item) && item.t !== 'd';
  }

  fullPathOf(item) {
    return this.#dir.replace(/\/$/, '') + '/' + item.u;
  }

  prefetchThumbnails() {
    if (this.#dir) fetch(toProxyQueueDir(this.#dir)).catch(() => {});
  }

  // Open an item: navigate into a directory, or load a media file.
  // passive=true suppresses the setFocusMode('viewer') call so that
  // programmatic advances (autoplay, queue-key next) don't steal focus.
  openItem(idx, passive = false) {
    if (idx < 0 || idx >= this.listing.length) return;
    const item = this.listing[idx];
    if (!this._isSelectable(item)) return;

    if (item.t === 'd') {
      this.#file = null;
      this.loadDir(this.#dir.replace(/\/$/, '') + '/' + item.u.replace(/\/$/, ''), true);
      setFocusMode('list');
    } else {
      this.#file = item.u;
      persistState(false);
      this.markActive(idx, true);
      this.selectItem(-1);
      showMediaFile(item.u);
      if (!passive) setFocusMode('viewer');
    }
  }

  // nextFile/prevFile are always passive: they don't change focus mode.
  // (Called from autoplay / ContentOccupant.nextItem, and from handleQueueKey.)
  nextFile() { super.nextFile(true); }
  prevFile() { super.prevFile(true); }

  goToParent() {
    const path = this.#dir.replace(/^file:\/\//, '').replace(/\/$/, '');
    this.#file = null;
    this.loadDir('file://' + (path.substring(0, path.lastIndexOf('/')) || '/'), true);
  }

  // ── Listing utilities ───────────────────────────────────────────────────────

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

    this.#dir   = dirUrl;
    // Uses FileList.listing setter (inherited) to replace listing contents, triggering re-render.
    this.listing = this.#sortItems(this.#filterItems(data.files || []));

    if (this.#file && !this.listing.some(i => i.u === this.#file)) {
      this.#file = null;
    }

    persistState(push, dirUrl, this.#file);
    if (ui.thumbnails) this.prefetchThumbnails();
    this.updateDirPath();
    applyUiState();
    showScreen('viewer');

    if (this.#file) {
      const selIdx = this.listing.findIndex(i => i.u === this.#file);
      if (selIdx >= 0) this.markActive(selIdx, false);
      showMediaFile(this.#file);
    } else {
      const firstFile = this.listing.findIndex(i => this._isViewable(i));
      if (firstFile >= 0) this.selectItem(firstFile, false);
      else if (this.listing.length > 0) this.selectItem(0, false);
    }
  }

  // ── Toggle operations ───────────────────────────────────────────────────────

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
    this.listing = this.#sortItems(this.listing);
    const labels = { name: 'NAME', mtime: 'DATE', size: 'SIZE' };
    if (btnSort) btnSort.textContent = labels[ui.sortBy] || 'NAME';
    if (this.#file) {
      const i = this.listing.findIndex(x => x.u === this.#file);
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
  //
  // FileList.handleKey owns navigation (arrows, j/k, page, home/end, enter,
  // space, right/left/backspace/u).  Selector intercepts 'R' before delegating,
  // and handles its own keys ('q', 's') after.
  // 'z', 'n', 'b' are intentionally not handled here (abandoned from the old
  // Selector; 'z'/'Z' toggle zoom/selector via the global dispatcher instead).

  handleKey(e, key, ctrl, plain) {
    if (!ctrl && plain && key === 'R') {
      if (this.#dir) this.loadDir(this.#dir, false);
      return;
    }
    super.handleKey(e, key, ctrl, plain);
    if (!plain) return;
    switch (key) {
      case '.': this.toggleHidden();   break;
      case 'q': this.handleQueueKey(); break;
      case 's': this.cycleSortBy();    break;
    }
  }

  // ── Queue key handling ──────────────────────────────────────────────────────

  // Called when the user presses 'q' with selector focus.
  // On a file: add it to the appropriate queue and advance to the next item.
  // On a directory: collect all queueable files (respecting CD/Disc subdirs)
  // and add them without advancing the cursor.
  handleQueueKey() {
    if (this.selectedIdx < 0 || !this.listing[this.selectedIdx]) return;
    const item = this.listing[this.selectedIdx];
    if (item.t === 'd') {
      _collectAndQueueDir(this.#dir.replace(/\/$/, '') + '/' + item.u).catch(() => {});
    } else {
      const mt = mediaType(item.u);
      if (mt !== 'audio' && mt !== 'video') return;
      _bcPost('media-queue', {
        cmd: 'q-add', type: mt,
        items: [Object.assign({}, item, { p: this.#dir })]
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

  get currentDir()  { return this.#dir;  }
  get currentFile() { return this.#file; }
}

const selector = new Selector();
