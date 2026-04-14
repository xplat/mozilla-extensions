selector.loadDir() is not awaited in viewer.js init and popstate handler, creating a race where sort/filter state may not be applied before the directory load begins acting on it.
