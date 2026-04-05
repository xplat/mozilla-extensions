## Dependency

Blocked on `selector-state-to-statejs`.  That issue must expose `_dir` and `_file` through the
state interface before this can land cleanly.  The implementation below assumes that is done.

## What to track

Add a `lastDir` field to the selector state (or a module-local variable until it migrates):
the full path of the most recently loaded directory.  Set it at the end of a successful
`loadDir` call, replacing whatever was there.

## Detection logic (in loadDir)

After the new directory is loaded, check whether `lastDir` is a strict descendant of the
new `_dir`:

    lastDir.startsWith(newDir + "/")   // or platform path-separator equivalent

If so, extract the immediate child of `newDir` on the path to `lastDir`:

    childName = lastDir.slice(newDir.length + 1).split("/")[0]

Then find the item in the loaded list whose name matches `childName`, set it as the active
item, and call `selectItem(true)` to scroll to it.

## Descendant vs. immediate child

The `.2.md` suggests matching on the immediate child is probably right (you navigated cd ..,
you want the cursor on the dir you just left, not deeper).  The `slice + split` approach above
naturally gives the immediate child regardless of how deep `lastDir` was.

## Edge cases

- If `childName` is not found in the listing (e.g. directory was renamed or deleted), fall
  through to the default cursor position — no error.
- If `lastDir` is not set (first load), do nothing special.
- Hash/popstate navigations that land in a parent should also trigger this; confirm that
  `loadDir` is the single choke point for all directory transitions.
