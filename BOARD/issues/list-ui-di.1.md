FileList.#ui is assigned in the constructor but never read; it is kept as a placeholder for dependency injection once the ui persistent-state object is retired.
