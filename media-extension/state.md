# state.js — URL/history state persistence

Persists SPA state across page reloads and history navigation using the URL
and the History API's accompanying JSON object.

## Namespaces

| Export     | Storage location                          |
|------------|-------------------------------------------|
| `Query`    | URL query string (`?key=value&…`)         |
| `Fragment` | URL fragment (`#key=value&…`)             |
| `Hidden`   | `history.state` JSON (not in the URL bar) |

## Content models

| Export        | JS type   | Notes                              |
|---------------|-----------|------------------------------------|
| `Integer`     | `number`  | Must be a safe integer              |
| `Float`       | `number`  | Any finite IEEE 754 double          |
| `String`      | `string`  |                                     |
| `Boolean`     | `boolean` | Serialized as `"true"` / `"false"`  |
| `Enum(…vals)` | `string`  | One of the supplied string literals |

## API

```js
import { reserve, save, push, onLoad,
         Query, Fragment, Hidden,
         Integer, String, Boolean, Enum } from './state.js';

// Claim a slot.  Throws if namespace+name is already reserved.
const handle = reserve(namespace, name, contentModel);
const handle = reserve(namespace, name, contentModel, defaultValue);

handle.get()      // → current value, defaultValue if absent, or null
handle.set(value) // update in-memory value (null clears the slot)

save()            // history.replaceState — persist without a new history entry
push()            // history.pushState    — persist as a new history entry

const off = onLoad(fn) // fn() is called after each popstate re-read
off()                  // remove the listener
```

## Semantics

- `reserve` reads the current URL at call-time.  Call `save()`/`push()` to
  write changes back.
- An absent URL value returns `defaultValue` (if provided) or `null`.
- Setting a slot to `null` removes it from the URL on the next flush.
- On `popstate` all registered slots are re-parsed and `onLoad` listeners fire.
