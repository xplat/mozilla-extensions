'use strict';
// ── viewer-load-context.js ────────────────────────────────────────────────────
//
// Load coordination primitives.  LoadContext tracks event-listener waits so
// they can all be cancelled atomically when a load is superseded.
//
// Declares these globals used by other modules:
//   CancelledError, LoadContext.

// Thrown (and caught silently) when a load is cancelled by a later navigation.
export class CancelledError extends Error {
  constructor() {
    super('load cancelled');
    this.name = 'CancelledError';
  }
}

// A LoadContext is created for each content load and passed to occupant.load().
// It provides waitFor(), which constructs a Promise that:
//   - resolves when the target event fires on the success element;
//   - rejects when any error event fires on an error element;
//   - rejects with CancelledError (and cleans up all listeners) when
//     ctx.cancel() is called — e.g. because a new navigation superseded it.
export class LoadContext {
  /** @type {(() => void)[]} */
  _cancellers;

  constructor() {
    this._cancellers = [];
    this._cancelled  = false;
  }

  /**
   * Wait for `element` to emit `event`.
   * @param {EventTarget} element - the target element to wait on
   * @param {string} event - the event name to listen for
   * @param {...[EventTarget, string, ((e: Event) => Error) | undefined]} errorTriples - zero or more [element, eventName, ErrorConstructor] tuples. When any named error event fires, the promise rejects with a new instance of the given ErrorConstructor (or plain Error if omitted).
   * @returns {Promise<Event>}
   */
  waitFor(element, event, ...errorTriples) {
    if (this._cancelled) return Promise.reject(new CancelledError());

    return new Promise((resolve, reject) => {
      /** @type {[EventTarget, string, EventListener][]} */
      const bound = [];

      const cleanup = () => {
        for (const [el, evt, fn] of bound) el.removeEventListener(evt, fn);
        const idx = this._cancellers.indexOf(cancel);
        if (idx >= 0) this._cancellers.splice(idx, 1);
      };

      const cancel = () => { cleanup(); reject(new CancelledError()); };

      /** @type {EventListener} */
      const onSuccess = (e) => { cleanup(); resolve(e); };
      bound.push([element, event, onSuccess]);
      element.addEventListener(event, onSuccess);

      for (const [errEl, errEvt, ErrClass] of errorTriples) {
        /** @type {EventListener} */
        const onError = (e) => { cleanup(); reject((ErrClass ?? (() => { return new Error(`caught ${errEvt}`); }))(e)); };
        bound.push([errEl, errEvt, onError]);
        errEl.addEventListener(errEvt, onError);
      }

      this._cancellers.push(cancel);
    });
  }

  // Returns true if this context has been cancelled.
  isCancelled() {
    return this._cancelled;
  }

  // Cancel all pending waitFor() calls, rejecting them with CancelledError.
  cancel() {
    if (this._cancelled) return;
    this._cancelled = true;
    const cs = this._cancellers.slice();
    this._cancellers.length = 0;
    for (const fn of cs) fn();
  }
}
