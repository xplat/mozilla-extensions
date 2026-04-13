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

// ---------------------------------------------------------------------------
// Content models
// ---------------------------------------------------------------------------

/**
 * @template T
 * @callback Validate
 * @param {any} x
 * @returns {x is T}
 */

/**
 * @template T
 * @typedef {Object} ContentModel
 * @property {string} tag
 * @property {Validate<T>} validate
 * @property {function(T): string} serialize
 * @property {function(string): T} deserialize
 */

/**
 * A content model describes how to validate, serialize, and deserialize a
 * value.  Serialization is used for Query and Fragment namespaces (URL text).
 * Hidden values are stored as-is in the JSON state object.
 */

/**
 * @type ContentModel<number>
 */
export const Integer = Object.freeze({
  tag: 'Integer',
  /** @type Validate<number> */
  validate(v) {
    if (!Number.isInteger(v))
      throw new TypeError(`Integer expected, got ${typeof v}: ${v}`);
    return true;
  },
  serialize: v => _String(v),
  deserialize(s) {
    const n = Number(s);
    if (!Number.isInteger(n) || s.trim() === '')
      throw new TypeError(`Cannot deserialize as Integer: "${s}"`);
    return n;
  },
});

/**
 * @type ContentModel<number>
 */
export const Float = Object.freeze({
  tag: 'Float',
  /** @type Validate<number> */
  validate(v) {
    if (typeof v !== 'number' || !Number.isFinite(v))
      throw new TypeError(`Finite float expected, got ${typeof v}: ${v}`);
    return true;
  },
  serialize: v => _String(v),
  deserialize(s) {
    const n = Number(s);
    if (!Number.isFinite(n) || s.trim() === '')
      throw new TypeError(`Cannot deserialize as Float: "${s}"`);
    return n;
  },
});

// Exported as "String" to match the spec, shadowing the global inside the
// module only.  Callers import by name so there is no ambiguity for them.
/**
 * @type ContentModel<string>
 */
export const String = Object.freeze({
  tag: 'String',
  /** @type Validate<string> */
  validate(v) {
    if (typeof v !== 'string')
      throw new TypeError(`String expected, got ${typeof v}: ${v}`);
    return true;
  },
  serialize:   v => v,
  deserialize: s => s,
});

/**
 * @type ContentModel<boolean>
 */
export const Boolean = Object.freeze({
  tag: 'Boolean',
  /** @type Validate<boolean> */
  validate(v) {
    if (typeof v !== 'boolean')
      throw new TypeError(`Boolean expected, got ${typeof v}: ${v}`);
    return true;
  },
  serialize:   v => v ? 'true' : 'false',
  deserialize(s) {
    if (s === 'true')  return true;
    if (s === 'false') return false;
    throw new TypeError(`Cannot deserialize as Boolean: "${s}"`);
  },
});

// Go full TS syntax to capture the variadic parameters correctly.
/**
 * Enum(...values) — one of a fixed set of string literals.
 *
 * @type <const T extends Array<string>>(...values: T) => ContentModel<T[number]>
 */
export function Enum(...values) {
  if (values.length === 0) throw new TypeError('Enum requires at least one value');
  const allowed = new Set(values);
  return Object.freeze({
    tag: 'Enum',
    allowed,
    /** @type Validate<(typeof values)[number]> */
    validate(v) {
      if (!allowed.has(v))
        throw new TypeError(`Enum value must be one of [${[...allowed].join(', ')}], got: ${v}`);
      return true;
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

/**
 * @type {'Query'}
 */
export const Query    = 'Query';
/**
 * @type {'Fragment'}
 */
export const Fragment = 'Fragment';
/**
 * @type {'Hidden'}
 */
export const Hidden   = 'Hidden';

const NAMESPACES = new Set(/** @type {const} */([Query, Fragment, Hidden]));

// ---------------------------------------------------------------------------
// Internal mutable state
// ---------------------------------------------------------------------------

/**
 * @template T
 * @typedef {T extends 'Hidden' ? any : string} Stored
 */

/**
 * @template T
 * @typedef Registration
 * @property {T} namespace
 * @property {string} name
 * @property {(data: Stored<T> | null) => void} load
 * @property {() => Stored<T> | null} save
 */

/**
 * @template T
 * @typedef {T extends any ? Registration<T> : never} DRegistration
 */

/**
 * registry: `"Namespace:name"` → registration metadata
 * @type {Map<string, DRegistration<'Query' | 'Fragment' | 'Hidden'>>}
 */
const registry = new Map();

/** Listeners to call after state is re-read on a popstate event. */
const loadListeners = new Set();

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse a URLSearchParams-style string (without a leading ? or #) into a Map
 * of raw string values.
 * @param {string} str
 * @returns {Map<string, string>}
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
 * @param {Map<string, string>} map
 * @returns {string}
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

/**
 * @returns {Record<string, any>}
 */
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
    const { namespace, name, load } = reg;

    if (namespace === Query) {
      load(queryRaw.get(name) ?? null);
    } else if (namespace === Fragment) {
      load(fragmentRaw.get(name) ?? null);
    } else if (namespace === Hidden) {
      load(hiddenRaw[name]);
    }
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
    const { namespace, name, save } = reg;
    const value = save();
    if (value === null) continue;  // absent — omit from URL / state

    if (namespace === Query) {
      querySerial.set(name, value);
    } else if (namespace === Fragment) {
      fragmentSerial.set(name, value);
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
 * @template T
 * @template const U extends (T | null)
 * @param {'Query' | 'Fragment' | 'Hidden'} namespace
 * @param {string}                      name
 * @param {ContentModel<T>}             contentModel  Integer | String | Boolean | Enum(…)
 * @param {U}                           defaultValue  Must satisfy contentModel or be null
 * @returns {{ get(): T | U, set(value: T | null): void }}
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

  if (defaultValue !== null && !contentModel.validate(defaultValue))
    throw new Error(`default value for ${namespace} parameter ${name} failed validation`);

  /** @type {T | null} */
  let deserialized = null;

  // Dispatch on namespace once so each branch constructs a monomorphic
  // Registration<T>.  Doing this inside a single polymorphic load/save would
  // leave Stored<namespace> un-narrowable, since TS can't narrow a type
  // parameter from a runtime check on a value.
  /** @type {DRegistration<'Query' | 'Fragment' | 'Hidden'>} */
  let reg;

  if (namespace === Hidden) {
    // Hidden values survive as their native JSON types; validate only.
    reg = {
      namespace, name,
      load(data) {
        try {
          if (data === null) {
            deserialized = null;
          } else if (contentModel.validate(data)) {
            deserialized = data;
          } else {
            throw new Error("validate returned false");
          }
        } catch {
          deserialized = null;
        }
      },
      save() { return deserialized; },
    };
  } else {
    // Query and Fragment both round-trip through the content model as strings.
    reg = {
      namespace, name,
      load(data) {
        try {
          deserialized = data === null ? null : contentModel.deserialize(data);
        } catch {
          // Malformed URL / stale state — treat as absent.
          deserialized = null;
        }
      },
      save() {
        return deserialized === null ? null : contentModel.serialize(deserialized);
      },
    };
  }

  registry.set(key, reg);

  // Re-run a targeted parse for just this new slot.
  reinitialize();

  return {
    /**
     * Returns the current value, or defaultValue if absent, or null if no
     * default was provided.
     */
    get() {
      return deserialized ?? defaultValue;
    },

    /**
     * Set the in-memory value.  Call save() or push() to persist.
     * Pass null to clear the slot (remove from URL on next flush).
     */
    set(value) {
      if (value === null) {
        deserialized = null;
        return;
      }
      contentModel.validate(value);
      deserialized = value;
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
