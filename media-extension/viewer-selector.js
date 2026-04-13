// ── Selector module ──────────────────────────────────────────────────────────
//
// Owns selector-pane state: the current directory and the selected file, and the
// UI filter state for the file listing (recursive traversal, hidden-file
// visibility, sort key).

import { ItemList, mediaType } from './viewer-list.js';
import { ContentOccupant } from './viewer-media.js';
import { ImageContent } from './viewer-media-image.js';
import { AudioContent } from './viewer-media-audio.js';
import { VideoContent } from './viewer-media-video.js';
import { content } from './viewer-content.js';
import * as State from './state.js';
import { queueAddAudio, queueAddVideo } from './viewer-queue-mgt.js';
import { requireElement } from './viewer-util.js';
/** @typedef {import('./viewer-util.js').FileListItem} FileListItem */

// ── DOM refs ──────────────────────────────────────────────────────────────────

var dirPathEl      = requireElement('dir-path');
var selectorPaneEl = requireElement('selector-pane');

var btnRecursive = requireElement('btn-recursive');
var btnHidden    = requireElement('btn-hidden');
var btnSort      = requireElement('btn-sort');

// ── Persistent UI state (selector filter fields) ──────────────────────────────
//
// Hidden slots survive pushState / replaceState round-trips but are not visible
// in the URL bar.  Query slots appear in the URL so the page can be bookmarked
// or shared.

const hRecursive  = State.reserve(State.Hidden, 'recursive',  State.Boolean,                        false);
const hShowHidden = State.reserve(State.Hidden, 'showHidden', State.Boolean,                        false);
const hSortBy     = State.reserve(State.Hidden, 'sortBy',     State.Enum('name', 'mtime', 'size'), 'name');
const hDir        = State.reserve(State.Query,  'dir',        State.String,                         null);
const hFile       = State.reserve(State.Query,  'file',       State.String,                         null);


// ── URL & history state ───────────────────────────────────────────────────────

/**
 * @param {boolean} doPush
 */
function persistState(doPush) {
  if (doPush) State.push(); else State.save();
}

// ── Apply UI state ────────────────────────────────────────────────────────────

function applyUiState() {
  btnRecursive.classList.toggle('active', hRecursive.get());
  btnHidden.classList.toggle('active', hShowHidden.get());
  /** @type {{name: string; mtime: string; size: string;}} */
  var labels = { name: 'NAME', mtime: 'DATE', size: 'SIZE' };
  var sortKey = hSortBy.get();
  btnSort.textContent = (sortKey in labels) ? labels[sortKey] : 'NAME';
}

// ── Proxy URL helpers ──────────────────────────────────────────────────────

/**
 * @param {string} dirUrl
 * @param {boolean} recursive
 */
function toProxyDir(dirUrl, recursive) {
  var path    = dirUrl.replace(/^file:\/\//, '');
  var encoded = path.split('/').map(encodeURIComponent).join('/');
  var url     = DIR_PROXY_PREFIX + encoded;
  if (recursive) url += '?recursive=1';
  return url;
}

/**
 * @param {string} dirUrl
 */
function toProxyQueueDir(dirUrl) {
  var path    = dirUrl.replace(/^file:\/\//, '');
  var encoded = path.split('/').map(encodeURIComponent).join('/');
  return QUEUE_DIR_PROXY_PREFIX + encoded;
}

export class Selector extends ItemList {

  /** @type {string | null} */
  #prevDir = null;

  // ── FileList overrides ──────────────────────────────────────────────────────

  /**
   * @param {FileListItem} item
   */
  _isSelectable(item) {
    if (item.t === 'd') return true;
    if (item.r === 0)   return false;
    return mediaType(item.u) !== 'unknown';
  }

  /**
   * @param {FileListItem} item
   */
  _isViewable(item) {
    return this._isSelectable(item) && item.t !== 'd';
  }

  /**
   * @param {FileListItem} item
   * @returns {string}
   */
  fullPathOf(item) {
    const dir = hDir.get();
    if (!dir) throw new Error('Cannot construct full path without a current directory');
    return dir.replace(/\/$/, '') + '/' + item.u;
  }

  /**
   * @returns {void}
   */
  prefetchThumbnails() {
    const dir = hDir.get();
    if (dir) fetch(toProxyQueueDir(dir)).catch(() => {});
  }

  /**
   * Open an item: navigate into a directory, or load a media file.
   * passive=true suppresses the this.ui.setFocusMode('viewer') call so that
   * programmatic advances (autoplay, queue-key next) don't steal focus.
   * @param {number} idx
   * @param {boolean} passive
   * @returns {void}
   */
  openItem(idx, passive = false) {
    if (idx < 0 || idx >= this.listing.length) return;
    const item = this.listing[idx];
    if (!this._isSelectable(item)) return;
    const dir = hDir.get();
    if (!dir) throw new Error('Cannot open item without a current directory');

    if (item.t === 'd') {
      hFile.set(null);
      this.loadDir(dir.replace(/\/$/, '') + '/' + item.u.replace(/\/$/, ''), true);
      this.ui.setFocusMode('list');
    } else {
      hFile.set(item.u);
      persistState(false);
      this.markActive(idx, !passive);
      this.showMediaFile({p: dir, ...item});
      if (passive) return;
      this.selectItem(-1);
      this.ui.setFocusMode('viewer');
    }
  }

  // nextFile/prevFile are always passive: they don't change focus mode.
  // (Called from autoplay / ContentOccupant.nextItem, and from handleQueueKey.)
  /**
   * @returns {void}
   */
  nextFile() { super.nextFile(true); }
  /**
   * @returns {void}
   */
  prevFile() { super.prevFile(true); }

  /**
   * @returns {void}
   */
  goToParent() {
    const dir = hDir.get();
    if (!dir) return;
    const path = dir.replace(/^file:\/\//, '').replace(/\/$/, '');
    hFile.set(null);
    this.loadDir('file://' + (path.substring(0, path.lastIndexOf('/')) || '/'), true);
  }

  // ── Listing utilities ───────────────────────────────────────────────────────

  /**
   * @param {FileListItem[]} items
   * @returns {FileListItem[]}
   */
  #sortItems(items) {
    const dirs  = items.filter(i => i.t === 'd');
    const files = items.filter(i => i.t !== 'd');
    /**
     * @callback FLIComparator
     * @param {FileListItem} a
     * @param {FileListItem} b
     * @returns {number}
     */
    
    /**
     * @type {Record<'mtime' | 'size' | 'name', FLIComparator>}
     */
    const cmp = {
      mtime: (a, b) => { return (b.m || 0) - (a.m || 0); },
      size: (a, b) => { return (b.s || 0) - (a.s || 0); },
      name: (a, b) => { return a.u.toLowerCase().localeCompare(b.u.toLowerCase()); },
    };
    dirs.sort(cmp[hSortBy.get()]);
    files.sort(cmp[hSortBy.get()]);
    return dirs.concat(files);
  }

  /**
   * @param {FileListItem[]} items
   * @returns {FileListItem[]}
   */
  #filterItems(items) {
    if (hShowHidden.get()) return items;
    return items.filter(i => i.u.replace(/\/$/, '').split('/').pop()?.charAt(0) !== '.');
  }

  // ── Directory loading ───────────────────────────────────────────────────────

  /**
   * @param {string} dirUrl
   * @param {boolean} push
   * @returns {Promise<void>}
   */
  async loadDir(dirUrl, push) {
    this.ui.showScreen('loading');

    const proxyUrl = toProxyDir(dirUrl, hRecursive.get());
    let data;
    try {
      const resp = await fetch(proxyUrl);
      if (!resp.ok) throw new Error('Server returned HTTP ' + resp.status);
      data = await resp.json();
    } catch (err) {
      const errorEl = document.getElementById('error-message');
      if (errorEl) errorEl.textContent = String(err);
      this.ui.showScreen('error');
      return;
    }

    const dirChanged = this.#prevDir !== dirUrl;
    hDir.set(dirUrl);
    this.#prevDir = dirUrl;
    // Uses FileList.listing setter (inherited) to replace listing contents, triggering re-render.
    this.listing = this.#sortItems(this.#filterItems(data.files || []));

    const file = hFile.get();
    if (file && !this.listing.some(i => i.u === file)) {
      hFile.set(null);
    }

    selectorPaneEl.classList.remove('no-dir');
    if (push) State.push(); else State.save();
    if (this.ui.thumbnails) this.prefetchThumbnails();
    this.updateDirPath();
    applyUiState();
    this.ui.showScreen('viewer');

    if (push || dirChanged) this.emitSelectorChanged();

    const currentFile = hFile.get();
    if (currentFile) {
      const selIdx = this.listing.findIndex(i => i.u === currentFile);
      if (selIdx >= 0) {
        this.markActive(selIdx, false);
        this.showMediaFile({p: dirUrl, ...this.listing[selIdx]});
      }
    } else {
      const firstFile = this.listing.findIndex(i => this._isViewable(i));
      if (firstFile >= 0) this.selectItem(firstFile, false);
      else if (this.listing.length > 0) this.selectItem(0, false);
    }
  }

  // ── Toggle operations ───────────────────────────────────────────────────────

  /**
   * @returns {void}
   */
  toggleRecursive() {
    hRecursive.set(!hRecursive.get());
    btnRecursive.classList.toggle('active', hRecursive.get());
    State.save();
    const dir = hDir.get();
    if (dir) this.loadDir(dir, false);
  }

  /**
   * @returns {void}
   */
  toggleHidden() {
    hShowHidden.set(!hShowHidden.get());
    btnHidden.classList.toggle('active', hShowHidden.get());
    State.save();
    const dir = hDir.get();
    if (dir) this.loadDir(dir, false);
  }

  /**
   * @returns {void}
   */
  cycleSortBy() {
    const orders = /** @type {const} */ (['name', 'mtime', 'size']);
    hSortBy.set(orders[(orders.indexOf(hSortBy.get()) + 1) % orders.length]);
    State.save();
    this.listing = this.#sortItems(this.listing);
    /** @type {{name: string; mtime: string; size: string;}} */
    const labels = { name: 'NAME', mtime: 'DATE', size: 'SIZE' };
    var sortKey = hSortBy.get();
    btnSort.textContent = (sortKey in labels) ? labels[sortKey] : 'NAME';
    const file = hFile.get();
    if (file) {
      const i = this.listing.findIndex(x => x.u === file);
      if (i >= 0) this.markActive(i, true);
    }
  }

  // ── Info / path display ─────────────────────────────────────────────────────

  /**
   * @returns {void}
   */
  updateDirPath() {
    const dir = hDir.get();
    if (!dir) return;
    const path = dir.replace(/^file:\/\//, '');
    dirPathEl.textContent = path;
    dirPathEl.title       = path;
    document.title        = path + ' — Media Viewer';
  }

  // ── Key handler ─────────────────────────────────────────────────────────────

  /**
   * @param {KeyboardEvent} e
   * @param {string} key
   * @param {boolean} ctrl
   * @param {boolean} plain
   * @returns {void}
   */
  handleKey(e, key, ctrl, plain) {
    if (!ctrl && plain && key === 'R') {
      const dir = hDir.get();
      if (dir) this.loadDir(dir, false);
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

  /** Called when the user presses 'q' with selector focus.
   * On a file: add it to the appropriate queue and advance to the next item.
   * On a directory: collect all queueable files (respecting CD/Disc subdirs)
   * and add them, then advance to the next directory/file.
   * @returns {void}
   */
  handleQueueKey() {
    if (this.selectedIdx < 0 || !this.listing[this.selectedIdx]) return;
    const dir = hDir.get();
    if (!dir) throw new Error('Cannot queue item without a current directory');
    const item = Object.assign({}, this.listing[this.selectedIdx], { p: dir });
    if (this.#queueItem(item)) this.selectNext();
  }

  // ── Queue collection helpers ────────────────────────────────────────────────

  /**
   * @param {FileListItem & {p: string}} item
   * @returns {boolean}
   */
  #queueItem(item) {
    if (item.t === 'd') {
      this.#collectAndQueueDir(item.p.replace(/\/$/, '') + '/' + item.u).catch(() => {});
      return true;
    } else {
      const mt = mediaType(item.u);
      if ((mt !== 'audio' && mt !== 'video') || item.r === 0) return false;
      if (mt === 'audio') queueAddAudio([item]);
      else queueAddVideo([item]);
      return true;
    }
  }

  /**
   * @param {string} dirUrl
   * @returns {Promise<void>}
   */
  async #collectAndQueueDir(dirUrl) {
    /** @type {(FileListItem & {p: string})[]} */
    var audioItems = [];
    /** @type {(FileListItem & {p: string})[]} */
    var videoItems = [];
    await this.#collectQueueables(dirUrl, audioItems, videoItems, true);
    queueAddAudio(audioItems);
    queueAddVideo(videoItems);
  }

  /**
   * @param {string} dirUrl
   * @param {(FileListItem & {p: string})[]} audioItems
   * @param {(FileListItem & {p: string})[]} videoItems
   * @param {boolean} [allowRecurse]
   * @returns {Promise<void>}
   */
  async #collectQueueables(dirUrl, audioItems, videoItems, allowRecurse) {
    var resp = await fetch(toProxyDir(dirUrl, false));
    if (!resp.ok) return;
    var data  = await resp.json();
    /** @type {FileListItem[]} */
    var items = data.files || [];

    var dirs  = items.filter(function(i) { return i.t === 'd'; });
    var files = items.filter(function(i) { return i.t !== 'd'; });

    files.sort(function(a, b) {
      return a.u.toLowerCase().localeCompare(b.u.toLowerCase());
    });
    files.forEach((f) => {
      var mt = mediaType(f.u);
      if (mt === 'audio') audioItems.push(Object.assign({}, f, { p: dirUrl }));
      else if (mt === 'video') videoItems.push(Object.assign({}, f, { p: dirUrl }));
    });

    // Recurse only into subdirectories named like "CD 1", "Disc 2", etc., but only once.
    if (allowRecurse) {
      var cdDirs = dirs.filter(function(d) { return /^(CD|Disc)\s*\d+$/i.test(d.u); });
      cdDirs.sort(function(a, b) {
        var aMatch = a.u.match(/\d+/);
        var bMatch = b.u.match(/\d+/);
        return (aMatch ? parseInt(aMatch[0]) : 0) - (bMatch ? parseInt(bMatch[0]) : 0);
      });
      for (var i = 0; i < cdDirs.length; i++) {
        await this.#collectQueueables(
          dirUrl.replace(/\/$/, '') + '/' + cdDirs[i].u, audioItems, videoItems, false
        );
      }
    }
  }

  // ── Public getters ──────────────────────────────────────────────────────────

  /**
   * @returns {string | null}
   */
  get currentDir()  { return hDir.get();  }
  /**
   * @returns {string | null}
   */
  get currentFile() { return hFile.get(); }

  /**
   * @returns {string | null}
   */
  titleFragment() {
    const dir = hDir.get();
    if (!dir) return null;
    return dir.replace(/^file:\/\//, '');
  }

  // ── Content factory ───────────────────────────────────────────────────────────

  /**
   * @param {FileListItem & {p: string}} stats
   * @returns {ContentOccupant | null}
   */
  makeContentOccupant(stats) {
    var type = mediaType(stats.u);
    if (type === 'image') return new ImageContent(this, stats);
    if (type === 'audio') return new AudioContent(this, stats);
    if (type === 'video') return new VideoContent(this, stats);
    return null;
  }

  // ── Show media file (dispatcher) ────────────────────────────────────────────

  /**
   * @param {FileListItem & {p: string}} stats
   */
  showMediaFile(stats) {
    const occupant = this.makeContentOccupant(stats);
    if (occupant) content.load(occupant);
  }

  /**
   * @returns {void}
   */
  emitSelectorChanged() {
    dispatchEvent(new CustomEvent('selectorChanged', { detail: { selector: this } }));
  }
}

/** @type {Selector | undefined} */
export let selector;

/**
 * @param {import('./viewer-ui.js').UIState} ui
 * @returns {void}
 */
export function initSelector(ui) {
  selector = new Selector(ui, selectorPaneEl);

  // Load initial directory from persisted state
  var dir = hDir.get();
  selectorPaneEl.classList.toggle('no-dir', !dir);
  if (!dir) return;
  selector?.loadDir(dir, false);
}

// ── History (back/forward) ────────────────────────────────────────────────────

State.onLoad(function() {
  var dir = hDir.get();
  selectorPaneEl.classList.toggle('no-dir', !dir);
  applyUiState();
  if (dir) {
    selector?.loadDir(dir, false);
  }
});

// ── Button listeners ───────────────────────────────────────────────────────

btnRecursive.addEventListener('click', () => selector?.toggleRecursive());
btnHidden.addEventListener('click', () => selector?.toggleHidden());
btnSort.addEventListener('click', () => selector?.cycleSortBy());
