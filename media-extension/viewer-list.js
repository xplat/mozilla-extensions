'use strict';
// ── FileList module ──────────────────────────────────────────────────────────
//
// Common class for file lists--selector and the audio and video queue panes.

class FileList {

  // ── Private fields ──────────────────────────────────────────────────────────

  #pane    = null;   // pane this file list lives in
  #container = null; // the .list-list scrollable container in the pane
  #listing = [];     // sorted/filtered entry objects from latest fetch
  #selIdx  = -1;     // index of selected item (-1 = none)
  #activeIdx  = -1;  // index of active item (-1 = none)
  #scrollIdx  = -1;  // index of item scrolled to (-1 = none)
  #items   = [];     // flat array of .file-item elements, parallel to #listing
  #listenersWired = false;
  #resizeObserver = null;
  #ui      = null;   // ui object, use it to persist and query state and such

  // Items are grouped into fixed-height .item-chunk containers so that
  // content-visibility: auto on each chunk lets Gecko skip building frame trees
  // for the ~900 off-screen chunks in a large directory.
  static #CHUNK_SIZE = 100;

  constructor(ui, pane) {
    this.#ui = ui;
    this.#pane = pane;
    this.#container = pane.querySelector(".list-list");
    return;
  }

  // ── Listing utilities ───────────────────────────────────────────────────────

  // Override to make non-selectable items.
  _isSelectable(item) {
    return true;
  }

  // Override to make items that aren't part of the next/prev sequence.
  // A viewable file must be selectable.
  _isViewable(item) {
    return true;
  }

  set listing(l) {
    this.#listing = l;
    this.renderListing();
  }

  // ── Selector rendering ──────────────────────────────────────────────────────

  // Wire delegated event listeners on fileListEl once.  click/dblclick bubble
  // naturally; load/error on <img> do not, so those use capture.
  #wireListeners() {
    if (this.#listenersWired) return;
    this.#listenersWired = true;

    this.#container.addEventListener('click', (e) => {
      const el = e.target.closest('.file-item');
      if (!el || el.classList.contains('dimmed')) return;
      setFocusMode('list');
      this.selectItem(parseInt(el.dataset.idx, 10), false);
      this.scrollIdx = -1;
    });

    this.#container.addEventListener('dblclick', (e) => {
      const el = e.target.closest('.file-item');
      if (!el || el.classList.contains('dimmed')) return;
      this.openItem(parseInt(el.dataset.idx, 10));
    });

    this.#container.addEventListener('load', (e) => {
      const t = e.target;
      if (t.tagName !== 'IMG' || !t.classList.contains('thumb-img')) return;
      t.classList.remove('thumb-loading');
    }, true);

    this.#container.addEventListener('error', (e) => {
      const t = e.target;
      if (t.tagName !== 'IMG' || !t.classList.contains('thumb-img')) return;
      t.classList.remove('thumb-loading');
      const item = t.closest('.file-item');
      if (item) item.classList.add('thumb-error');
    }, true);

    // CHANGE NEEDED: attach a resizeObserver to this.#container.
    // - disconnect it during the actual list rendering and reconnect it after.
    //   leave it disconnected if there are no items.
    // - track old clientHeight, scrollHeight, old height of #items[0] in
    //   private fields.
    // - when they change, pick a "center": #scrollIdx, #selIdx, #activeIdx in
    //   priority order.
    // - compute where the "center" was and is using the fact that all of
    //   #items have the same height.
    // - there is a height h where the ratio of (h - top of "center") to
    //   (bottom of "center" - h) is the same as the ratio of (h - top of
    //   visible area) to (bottom of visible area - h).
    // - set scrollTop so the visible area after is positioned so the matching
    //   ratio is the same before and after the height changes.
    // - keep in mind the actual ratio may be infinite so be sure to calculate
    //   the new scrollTop in a way that is numerically stable.
    // - if there is no appropriate center as a single item, consider the
    //   entire area from 0 to scrollHeight to be the center.
    // - when one of the heights is 0 because of a lack of visibility, just
    //   drop the event in an early guard.
  }

  renderList() {
    this.#wireListeners();
    this.#container.innerHTML = '';
    this.#items  = [];
    this.#selIdx = -1;
    this.#activeIdx = -1;
    this.#scrollIdx = -1;
    this.#container.classList.toggle('thumbnails', ui.thumbnails);

    let chunk = null;
    this.#listing.forEach((item, idx) => {
      if (idx % Selector.#CHUNK_SIZE === 0) {
        chunk = document.createElement('div');
        chunk.className = 'item-chunk';
        this.#container.appendChild(chunk);
      }

      const el = document.createElement('div');
      el.className = 'file-item';
      el.dataset.idx = String(idx);

      const mtype = mediaType(item.u);
      if (!this._isSelectable(item)) el.classList.add('dimmed');
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
  // delegated capture listeners on this.#container rather than per-element.
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
      imgEl.src       = toProxyThumb(this.fullPathOf(item));
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
    if (this.#selIdx >= 0) this.#items[this.#selIdx].classList.remove('selected');
    this.#selIdx = idx;
    if (idx < 0) return;
    const el = this.#items[idx];
    if (!el) return;
    el.classList.add('selected');
    if (!scroll) return;
    el.scrollIntoView({ block: 'center' });
    this.#scrollIdx = -1;
  }

  markActive(idx, scroll) {
    if (idx < 0 || idx >= this.#listing.length) return;
    if (this.#activeIdx >= 0) this.#items[this.#activeIdx].classList.remove('active');
    this.#activeIdx = idx;
    const el = this.#items[idx];
    if (!el) return;
    el.classList.add('active');
    if (!scroll) return;
    el.scrollIntoView({ block: 'center' });
  }

  // ── Item opening / file navigation ─────────────────────────────────────────
  // A lot of these are meant to be overridden.

  // passive means be unobtrusive to the UI because this was triggered by some
  // background process like autoplay.
  openItem(idx, passive = false) {
    if (idx < 0 || idx >= this.#listing.length) return;
    const item = this.#listing[idx];
    if (!this._isSelectable(item)) return;
    this.markActive(idx, true);
    return item;
  }

  receiveFocus() {
    if (this.#activeIdx >= 0) {
      this.selectItem(this.#activeIdx, true);
    }
  }

  yieldFocus() {
    if (this.#selIdx == this.#activeIdx) {
      this.#selIdx = -1;
    }
  }

  goToParent() {
    return;
  }

  nextFile(passive = false) {
    for (let cur = this.#activeIdx + 1; cur < this.#listing.length; cur++) {
      if (this._isViewable(this.#listing[cur])) {
        return openItem(cur, passive);
      }
    }
  }
  
  prevFile(passive = false) {
    for (let cur = this.#activeIdx - 1; cur >= 0; cur--) {
      if (this._isViewable(this.#listing[cur])) {
        return openItem(cur, passive);
      }
    }
  }

  // ── Keyboard navigation helpers ─────────────────────────────────────────────

  #startIdx(goingUp) {
    if (this.#selIdx >= 0) {
      return this.#selIdx;
    } else if (this.#activeIdx >= 0) {
      return this.activeIdx;
    } else if (goingUp) { 
      return this.#listing.length;
    } else {
      return -1; 
    }
  }

  findSelectable(start, limit) {
    for (let cur = start; cur <= limit; cur++) {
      if (this._isSelectable(this.#listing[cur])) {
        return cur;
      }
    }
    return -1;
  }

  findLastSelectable(start, limit) {
    for (let cur = start; cur >= limit; cur--) {
      if (this._isSelectable(this.#listing[cur])) {
        return cur;
      }
    }
    return -1;
  }

  pageDown() { 
    const start = max(0,this.#startIdx(false));

    // Spec:
    // - Find the last item that will fit in a #this.container.clientHeight
    //   with `start`, or the next item if #this.container.clientHeight is
    //   less than twice as big as an item height.  Set #scrollIdx to this.
    // - Scroll the new #scrollIdx onto the page with "nearest".
    // - Select the last selectable index between the new #scrollIdx and start,
    //   inclusive, with selectItem(..., false).  If there is no selectable
    //   index in range, just return and leave the selection where it was.
  }

  pageUp() {
    // Spec: Like pageDown but in the opposite direction.
  }

  selectNext() {
    const start = this.#startIdx(false);
    const next = this.findSelectable(start + 1, this.#listing.length - 1);
    if (next < 0) return;
    this.selectItem(next, true);
  }

  selectPrev() {
    const start = this.#startIdx(true);
    const next = this.findSelectable(start - 1, 0);
    if (next < 0) return;
    this.selectItem(next, true);
  }

  jumpToEdge(dir) {
    if (dir > 0) {
      for (let i = 0; i < this.#listing.length; i++) {
        if (this._isSelectable(this.#listing[i])) { this.selectItem(i, true); return; }
      }
    } else {
      for (let i = this.#listing.length - 1; i >= 0; i--) {
        if (this._isSelectable(this.#listing[i])) { this.selectItem(i, true); return; }
      }
    }
  }

  // ── Key handler ─────────────────────────────────────────────────────────────

  handleKey(e, key, ctrl, plain) {
    if (!plain) return;
    switch (key) {
      case 'ArrowDown':  e.preventDefault(); this.selectNext();         break;
      case 'ArrowUp':    e.preventDefault(); this.selectPrev();         break;
      case 'j':                              this.selectNext();         break;
      case 'k':                              this.selectPrev();         break;
      case 'PageDown':   e.preventDefault(); this.pageDown();           break;
      case 'PageUp':     e.preventDefault(); this.pageUp();             break;
      case 'Home':       e.preventDefault(); this.jumpToEdge(1);        break;
      case 'End':        e.preventDefault(); this.jumpToEdge(-1);       break;
      case ' ':
      case 'ArrowRight':
      case 'Enter':      e.preventDefault();
        if (this.#selIdx >= 0 && this.#selIdx != this.#activeIdx) {
          this.openItem(this.#selIdx);
        } else {
          setFocusMode('viewer');
        }
        break;
      case 'ArrowLeft':
      case 'Backspace':
      case 'u':          e.preventDefault(); this.goToParent(); break;
    }
  }

  // ── Public getters ──────────────────────────────────────────────────────────

  get listing()     { return this.#listing;   }
  get activeIdx()   { return this.#activeIdx; }
  get selectedIdx() { return this.#selIdx;    }
}
