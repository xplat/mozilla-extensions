LoadContext.waitFor uses `ErrClass.prototype` to distinguish constructors from factory callables, which is unreliable for arrow functions, bound functions, and some transpiled classes.
