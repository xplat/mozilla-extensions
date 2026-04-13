// ── viewer-util.js ────────────────────────────────────────────────────────────
//
// Utility functions and helpers shared across viewer scripts:
//   - WatchableEventTarget: EventTarget subclass that tracks active listeners
//   - fmtSize, fmtDate: formatting utilities
//

/**
 * @typedef {Object} FileListItem
 * @property {string} u - filename
 * @property {string} [p] - parent directory
 * @property {string} t - type string (e.g., 'd' for directory)
 * @property {number} [r] - readable (0 if not readable)
 * @property {number} m - modified time (seconds since unix epoch)
 * @property {number} s - size
 */

// ── WatchableEventTarget ───────────────────────────────────────────────────────
//
// EventTarget subclass that tracks which event listeners are attached.
// Callers can use watched() to check if anyone is listening.

class WatchableEventTarget extends EventTarget {
  constructor() {
    super();
    this._listeners = new Map(); // event name -> Set of listener functions
  }

  /**
   * @param {string} type
   * @param {EventListenerOrEventListenerObject} listener
   * @param {AddEventListenerOptions | boolean} [options]
   */
  addEventListener(type, listener, options) {
    if (!this._listeners.has(type)) {
      this._listeners.set(type, new Set());
    }
    this._listeners.get(type).add(listener);
    super.addEventListener(type, listener, options);
  }

  /**
   * @param {string} type
   * @param {EventListenerOrEventListenerObject} listener
   * @param {AddEventListenerOptions | boolean} [options]
   */
  removeEventListener(type, listener, options) {
    super.removeEventListener(type, listener, options);
    if (this._listeners.has(type)) {
      this._listeners.get(type).delete(listener);
    }
  }

  /**
   * Returns true if there are any active listeners for this event or any event.
   * @param {string} [eventType]
   */
  watched(eventType) {
    if (eventType) {
      return this._listeners.has(eventType) && this._listeners.get(eventType).size > 0;
    }
    // Check if any event type has listeners
    for (const [_, listeners] of this._listeners) {
      if (listeners.size > 0) return true;
    }
    return false;
  }
}

// ── DOM element helpers ────────────────────────────────────────────────────────

/**
 * @overload
 * @param {string} id
 * @returns {HTMLElement}
 */

/**
 * @template {HTMLElement} T
 * @overload
 * @param {string} id
 * @param {new() => T} cls
 * @returns {T}
 */

/**
 * Get a required DOM element by id, throwing if not found.
 * Optionally verify it's an instance of a specific class (e.g., HTMLVideoElement).
 * @param {string} id
 * @param {Function} [cls]
 * @returns {HTMLElement}
 * @throws {Error} if element not found or is not an instance of cls
 */
function requireElement(id, cls) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Required element #${id} not found`);
  if (cls && !(el instanceof cls)) {
    throw new Error(`Element #${id} is not an instance of ${cls.name}`);
  }
  return el;
}

/**
 * Casts something to HTMLElement, replacing with null if it isn't actually one.
 * @param {EventTarget | null} it
 * @returns {HTMLElement | null}
 */
function asHTML(it) {
  if (it && (it instanceof HTMLElement)) return it;
  return null;
}

// ── Formatting utilities ───────────────────────────────────────────────────────

/**
 * @param {number} bytes
 */
function fmtSize(bytes) {
  if (bytes < 1024)               return bytes + '\u00a0B';
  if (bytes < 1024 * 1024)        return (bytes / 1024).toFixed(1) + '\u00a0KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1048576).toFixed(1) + '\u00a0MB';
  return (bytes / 1073741824).toFixed(1) + '\u00a0GB';
}

/**
 * @param {number} unixSecs
 * @param {boolean} full
 */
function fmtDate(unixSecs, full) {
  var d = new Date(unixSecs * 1000);
  return full ? d.toLocaleString() : d.toLocaleDateString();
}

export { WatchableEventTarget, fmtSize, fmtDate, requireElement, asHTML };
