/**
 * state.js — URL-and-history state persistence for single-page applications.
 *
 * Values live in three namespaces:
 *   Query    — URL query string (?key=value&…)
 *   Fragment — URL fragment after # (?key=value&… encoded there)
 *   Hidden   — history.state JSON object (not visible in the URL bar)
 *
 * Use reserve() to claim a slot; use save()/push() to flush; use onLoad() to
 * react to history navigation.
 */

// Capture built-ins before we shadow them with our exports.
const _String  = globalThis.String;
const _Boolean = globalThis.Boolean;
const _Number  = globalThis.Number;

// ---------------------------------------------------------------------------
// Content models
// ---------------------------------------------------------------------------

/**
 * A content model describes how to validate, serialize, and deserialize a
 * value.  Serialization is used for Query and Fragment namespaces (URL text).
 * Hidden values are stored as-is in the JSON state object.
 */

export const Integer = Object.freeze({
  tag: 'Integer',
  validate(v) {
    if (!_Number.isInteger(v))
      throw new TypeError(`Integer expected, got ${typeof v}: ${v}`);
  },
  serialize: v => _String(v),
  deserialize(s) {
    const n = _Number(s);
    if (!_Number.isInteger(n) || s.trim() === '')
      throw new TypeError(`Cannot deserialize as Integer: "${s}"`);
    return n;
  },
});

export const Float = Object.freeze({
  tag: 'Float',
  validate(v) {
    if (typeof v !== 'number' || !_Number.isFinite(v))
      throw new TypeError(`Finite float expected, got ${typeof v}: ${v}`);
  },
  serialize: v => _String(v),
  deserialize(s) {
    const n = _Number(s);
    if (!_Number.isFinite(n) || s.trim() === '')
      throw new TypeError(`Cannot deserialize as Float: "${s}"`);
    return n;
  },
});

// Exported as "String" to match the spec, shadowing the global inside the
// module only.  Callers import by name so there is no ambiguity for them.
export const String = Object.freeze({
  tag: 'String',
  validate(v) {
    if (typeof v !== 'string')
      throw new TypeError(`String expected, got ${typeof v}: ${v}`);
  },
  serialize:   v => v,
  deserialize: s => s,
});

export const Boolean = Object.freeze({
  tag: 'Boolean',
  validate(v) {
    if (typeof v !== 'boolean')
      throw new TypeError(`Boolean expected, got ${typeof v}: ${v}`);
  },
  serialize:   v => v ? 'true' : 'false',
  deserialize(s) {
    if (s === 'true')  return true;
    if (s === 'false') return false;
    throw new TypeError(`Cannot deserialize as Boolean: "${s}"`);
  },
});

/**
 * Enum(...values) — one of a fixed set of string literals.
 *
 * @param {...string} values  The allowed values.
 * @returns {ContentModel}
 */
export function Enum(...values) {
  if (values.length === 0) throw new TypeError('Enum requires at least one value');
  const allowed = new Set(values);
  return Object.freeze({
    tag: 'Enum',
    allowed,
    validate(v) {
      if (!allowed.has(v))
        throw new TypeError(`Enum value must be one of [${[...allowed].join(', ')}], got: ${v}`);
    },
    serialize:   v => v,
    deserialize(s) {
      if (!allowed.has(s))
        throw new TypeError(`Cannot deserialize as Enum([${[...allowed].join(', ')}]): "${s}"`);
      return s;
    },
  });
}

// ---------------------------------------------------------------------------
// Namespace constants (strings used as keys in the registry)
// ---------------------------------------------------------------------------

export const Query    = 'Query';
export const Fragment = 'Fragment';
export const Hidden   = 'Hidden';

const NAMESPACES = new Set([Query, Fragment, Hidden]);

// ---------------------------------------------------------------------------
// Internal mutable state
// ---------------------------------------------------------------------------

/** registry: `"Namespace:name"` → registration metadata */
const registry = new Map();

/**
 * In-memory current values, keyed by namespace then by name.
 * These are always deserialized (live) values.
 */
const current = {
  [Query]:    new Map(),
  [Fragment]: new Map(),
  [Hidden]:   new Map(),
};

/** Listeners to call after state is re-read on a popstate event. */
const loadListeners = new Set();

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse a URLSearchParams-style string (without a leading ? or #) into a Map
 * of raw string values.
 */
function parseParams(str) {
  const out = new Map();
  if (!str) return out;
  for (const [k, v] of new URLSearchParams(str)) out.set(k, v);
  return out;
}

/**
 * Serialize a Map of {name → rawString} to a URLSearchParams string, sorted
 * for determinism.
 */
function serializeParams(map) {
  const p = new URLSearchParams();
  for (const [k, v] of [...map].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    p.set(k, v);
  return p.toString();
}

// ---------------------------------------------------------------------------
// State initialization and re-initialization (on navigation)
// ---------------------------------------------------------------------------

function readHiddenState() {
  const s = history.state;
  return (s && typeof s === 'object') ? s : {};
}

/**
 * (Re-)read all registered values from the current location and history.state.
 * Called once at module load and again on every popstate event.
 */
function reinitialize() {
  const queryRaw    = parseParams(location.search.slice(1));
  const fragmentRaw = parseParams(location.hash.slice(1));
  const hiddenRaw   = readHiddenState();

  for (const reg of registry.values()) {
    const { namespace, name, contentModel } = reg;
    let deserialized = null;

    try {
      if (namespace === Query && queryRaw.has(name)) {
        deserialized = contentModel.deserialize(queryRaw.get(name));
      } else if (namespace === Fragment && fragmentRaw.has(name)) {
        deserialized = contentModel.deserialize(fragmentRaw.get(name));
      } else if (namespace === Hidden && Object.hasOwn(hiddenRaw, name)) {
        // Hidden values survive as their native JSON types; validate only.
        const raw = hiddenRaw[name];
        contentModel.validate(raw);
        deserialized = raw;
      }
    } catch {
      // Malformed URL / stale state — treat as absent.
      deserialized = null;
    }

    current[namespace].set(name, deserialized);
  }
}

// Run once on module load.
reinitialize();

// ---------------------------------------------------------------------------
// Popstate listener
// ---------------------------------------------------------------------------

window.addEventListener('popstate', () => {
  reinitialize();
  for (const listener of loadListeners) {
    try { listener(); } catch (err) { console.error('state onLoad listener threw:', err); }
  }
});

// ---------------------------------------------------------------------------
// Flush helpers (build URL + state and call history API)
// ---------------------------------------------------------------------------

function buildFlushArgs() {
  // Collect serialized Query and Fragment values.
  const querySerial    = new Map();
  const fragmentSerial = new Map();
  const hiddenSerial   = Object.create(null);

  for (const reg of registry.values()) {
    const { namespace, name, contentModel } = reg;
    const value = current[namespace].get(name);
    if (value === null) continue;  // absent — omit from URL / state

    if (namespace === Query) {
      querySerial.set(name, contentModel.serialize(value));
    } else if (namespace === Fragment) {
      fragmentSerial.set(name, contentModel.serialize(value));
    } else {
      hiddenSerial[name] = value;  // stored as native JSON type
    }
  }

  const search   = querySerial.size    ? '?' + serializeParams(querySerial)    : '';
  const hash     = fragmentSerial.size ? '#' + serializeParams(fragmentSerial) : '';
  const url      = location.pathname + search + hash;
  const stateObj = { ...hiddenSerial };

  return [stateObj, url];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * reserve(namespace, name, contentModel[, defaultValue])
 *
 * Claim a persistent slot.  Returns a handle with `.get()` and `.set(value)`
 * that read/write the in-memory current value (call save() or push() to
 * persist to the URL / history).
 *
 * Throws if the same namespace + name pair is reserved more than once.
 *
 * @param {'Query'|'Fragment'|'Hidden'} namespace
 * @param {string}                      name
 * @param {ContentModel}                contentModel  Integer | String | Boolean | Enum(…)
 * @param {*}                          [defaultValue] Must satisfy contentModel
 * @returns {{ get(): *, set(value: *): void }}
 */
export function reserve(namespace, name, contentModel, defaultValue) {
  if (!NAMESPACES.has(namespace))
    throw new TypeError(`Unknown namespace "${namespace}". Use Query, Fragment, or Hidden.`);
  if (typeof name !== 'string' || !name)
    throw new TypeError('name must be a non-empty string');
  if (!contentModel || typeof contentModel.validate !== 'function')
    throw new TypeError('contentModel must be one of Integer, String, Boolean, or Enum(…)');

  const key = `${namespace}:${name}`;
  if (registry.has(key))
    throw new Error(`State slot already reserved: ${namespace}/${name}`);

  const hasDefault = arguments.length >= 4;
  if (hasDefault) contentModel.validate(defaultValue);

  const reg = { namespace, name, contentModel, defaultValue, hasDefault };
  registry.set(key, reg);

  // Initialize this slot from the URL (it may have been parsed already if
  // reinitialize() ran before reserve() was called, but new reservations
  // after module load need their slot populated).
  if (!current[namespace].has(name)) {
    current[namespace].set(name, null);
    // Re-run a targeted parse for just this new slot.
    reinitialize();
  }

  return {
    /**
     * Returns the current value, or defaultValue if absent, or null if no
     * default was provided.
     */
    get() {
      const v = current[namespace].get(name) ?? null;
      if (v === null && hasDefault) return defaultValue;
      return v;
    },

    /**
     * Set the in-memory value.  Call save() or push() to persist.
     * Pass null to clear the slot (remove from URL on next flush).
     */
    set(value) {
      if (value === null) {
        current[namespace].set(name, null);
        return;
      }
      contentModel.validate(value);
      current[namespace].set(name, value);
    },
  };
}

/**
 * save()
 *
 * Persist current in-memory state to the URL without adding a history entry
 * (history.replaceState).
 */
export function save() {
  const [stateObj, url] = buildFlushArgs();
  history.replaceState(stateObj, '', url);
}

/**
 * push()
 *
 * Clone the current state into a new history entry (history.pushState),
 * allowing the user to navigate back to the previous state.
 */
export function push() {
  const [stateObj, url] = buildFlushArgs();
  history.pushState(stateObj, '', url);
}

/**
 * onLoad(listener)
 *
 * Register a callback to be invoked after the state has been fully
 * re-read from a popstate (back/forward navigation) event.
 *
 * @param {() => void} listener
 * @returns {() => void}  A function that removes the listener when called.
 */
export function onLoad(listener) {
  if (typeof listener !== 'function')
    throw new TypeError('onLoad expects a function');
  loadListeners.add(listener);
  return () => loadListeners.delete(listener);
}
