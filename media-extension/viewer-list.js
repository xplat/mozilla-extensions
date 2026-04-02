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

  // Heights tracked for ResizeObserver scroll-position preservation.
  #itemH   = 0;
  #clientH = 0;
  #scrollH = 0;

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
    this.renderList();
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
      this.#scrollIdx = -1;
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

    // ResizeObserver preserves the scroll position of a "center" item across
    // container/item height changes (e.g. thumbnail mode toggle, font resize).
    //
    // PRIMARY formula — equal-ratio invariant: there exists a point h such that
    // h's fractional position within the center item equals its fractional
    // position within the viewport.  Solving the equal-ratio equation gives:
    //
    //   frac    = (cTop - visTop) / (clientH - cSize)
    //   visTop' = cTop' + frac * (cSize' - clientH')
    //
    // This formula divides by (clientH - cSize).  When the viewport is nearly
    // the same height as the center item that denominator is small, and any
    // rounding in the subtraction is amplified.
    //
    // FALLBACK formula — center-fraction invariant: when the item fills most of
    // the viewport (|clientH - cSize| < ½ cSize) we instead preserve the
    // fractional position of the viewport centre within the center item:
    //
    //   centerFrac = (visTop + clientH/2 - cTop) / cSize
    //   visTop'    = cTop' + centerFrac * cSize' - clientH'/2
    //
    // The denominator here is cSize (always large), so there is no cancellation.
    // Both formulas share the same limit as clientH → cSize, so the switch is
    // seamless at the boundary.  The fallback is NOT used for the whole-list
    // pseudo-center (cSize = scrollH >> clientH), where the primary formula is
    // always well-conditioned.
    //
    // Off-screen items are not used as a center: if the preferred item has been
    // scrolled out of view (e.g. by the scroll wheel or scrollbar) we fall back
    // to the whole-list pseudo-center so we preserve what is actually visible.
    this.#resizeObserver = new ResizeObserver((_entries) => {
      const itemH_new   = this.#items[0]?.offsetHeight ?? 0;
      const clientH_new = this.#container.clientHeight;
      const scrollH_new = this.#container.scrollHeight;

      // Drop events while the container is invisible.
      if (!clientH_new || !scrollH_new) return;

      const itemH_old   = this.#itemH;
      const clientH_old = this.#clientH;
      const scrollH_old = this.#scrollH;
      const visTop_old  = this.#container.scrollTop;

      // Always update stored heights so the next event has fresh baselines.
      this.#itemH   = itemH_new;
      this.#clientH = clientH_new;
      this.#scrollH = scrollH_new;

      // First observation after (re)connect: no old baseline to work from.
      if (!itemH_old || !clientH_old || !scrollH_old) return;
      // Nothing relevant changed.
      if (itemH_new === itemH_old && clientH_new === clientH_old) return;

      // Pick the highest-priority center item that is at least partially
      // visible.  If none overlaps the viewport, fall through to -1.
      let centerIdx = this.#scrollIdx >= 0 ? this.#scrollIdx
                    : this.#selIdx    >= 0 ? this.#selIdx
                    : this.#activeIdx >= 0 ? this.#activeIdx
                    : -1;

      if (centerIdx >= 0) {
        const cTop = centerIdx * itemH_old;
        if (cTop + itemH_old <= visTop_old || cTop >= visTop_old + clientH_old) {
          centerIdx = -1;
        }
      }

      let cTop_old, cSize_old, cTop_new, cSize_new;
      if (centerIdx >= 0) {
        cTop_old  = centerIdx * itemH_old;  cSize_old = itemH_old;
        cTop_new  = centerIdx * itemH_new;  cSize_new = itemH_new;
      } else {
        // No on-screen center item: treat the entire scroll range as the
        // center, which degrades gracefully to preserving fractional position.
        cTop_old  = 0;  cSize_old = scrollH_old;
        cTop_new  = 0;  cSize_new = scrollH_new;
      }

      const denom = clientH_old - cSize_old;
      let visTop_new;

      if (denom === 0) {
        // Degenerate: viewport exactly matches center size.  Align tops.
        visTop_new = cTop_new;
      } else if (centerIdx >= 0 && 2 * Math.abs(denom) < cSize_old) {
        // Near-degenerate single-item center: switch to center-fraction formula.
        const centerFrac = (visTop_old + clientH_old / 2 - cTop_old) / cSize_old;
        visTop_new = cTop_new + centerFrac * cSize_new - clientH_new / 2;
      } else {
        const frac = (cTop_old - visTop_old) / denom;
        visTop_new = cTop_new + frac * (cSize_new - clientH_new);
      }

      this.#container.scrollTop = Math.max(0, Math.round(visTop_new));
    });
  }

  renderList() {
    this.#wireListeners();
    this.#resizeObserver.disconnect();

    this.#container.innerHTML = '';
    this.#items  = [];
    this.#selIdx = -1;
    this.#activeIdx = -1;
    this.#scrollIdx = -1;
    this.#container.classList.toggle('thumbnails', this.#ui.thumbnails);

    let chunk = null;
    this.#listing.forEach((item, idx) => {
      if (idx % FileList.#CHUNK_SIZE === 0) {
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
    const tail = this.#listing.length % FileList.#CHUNK_SIZE;
    if (tail !== 0 && chunk) chunk.style.setProperty('--chunk-size', tail);

    // Reconnect observer only when there is content to observe.  The first
    // callback establishes the baseline heights; no scroll adjustment is made.
    if (this.#items.length > 0) {
      this.#itemH   = 0;  // reset so first callback skips scroll adjustment
      this.#clientH = 0;
      this.#scrollH = 0;
      this.#resizeObserver.observe(this.#container);
    }
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
    if (this.#selIdx === this.#activeIdx) {
      this.#selIdx = -1;
    }
  }

  goToParent() {
    return;
  }

  nextFile(passive = false) {
    for (let cur = this.#activeIdx + 1; cur < this.#listing.length; cur++) {
      if (this._isViewable(this.#listing[cur])) {
        return this.openItem(cur, passive);
      }
    }
  }

  prevFile(passive = false) {
    for (let cur = this.#activeIdx - 1; cur >= 0; cur--) {
      if (this._isViewable(this.#listing[cur])) {
        return this.openItem(cur, passive);
      }
    }
  }

  // ── Keyboard navigation helpers ─────────────────────────────────────────────

  #startIdx(goingUp) {
    if (this.#selIdx >= 0) {
      return this.#selIdx;
    } else if (this.#activeIdx >= 0) {
      return this.#activeIdx;
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
    const start   = Math.max(0, this.#startIdx(false));
    const itemH   = this.#items[0]?.offsetHeight ?? 0;
    const clientH = this.#container.clientHeight;

    // If the viewport fits at least two items, advance by a full page (the
    // last item that still fits on-screen alongside start).  Otherwise just
    // step one item so we never skip past unreachable items.
    let end;
    if (itemH > 0 && clientH >= 2 * itemH) {
      end = Math.min(start + Math.floor(clientH / itemH) - 1, this.#listing.length - 1);
    } else {
      end = Math.min(start + 1, this.#listing.length - 1);
    }

    this.#scrollIdx = end;
    this.#items[end]?.scrollIntoView({ block: 'nearest' });

    // Select the selectable item closest to the new scroll position.
    const sel = this.findLastSelectable(end, start);
    if (sel < 0) return;
    this.selectItem(sel, false);
  }

  pageUp() {
    const start   = Math.min(this.#listing.length - 1, this.#startIdx(true));
    const itemH   = this.#items[0]?.offsetHeight ?? 0;
    const clientH = this.#container.clientHeight;

    let end;
    if (itemH > 0 && clientH >= 2 * itemH) {
      end = Math.max(start - Math.floor(clientH / itemH) + 1, 0);
    } else {
      end = Math.max(start - 1, 0);
    }

    this.#scrollIdx = end;
    this.#items[end]?.scrollIntoView({ block: 'nearest' });

    // Select the selectable item closest to the new scroll position.
    const sel = this.findSelectable(end, start);
    if (sel < 0) return;
    this.selectItem(sel, false);
  }

  selectNext() {
    const start = this.#startIdx(false);
    const next = this.findSelectable(start + 1, this.#listing.length - 1);
    if (next < 0) return;
    this.selectItem(next, true);
  }

  selectPrev() {
    const start = this.#startIdx(true);
    const next = this.findLastSelectable(start - 1, 0);
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
        if (this.#selIdx >= 0 && this.#selIdx !== this.#activeIdx) {
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
