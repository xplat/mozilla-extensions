Replace `.catch(function() {})` with a handler that attaches an ErrorContent to the pane.

Prerequisite: GifContent needs a `.clone()` method (required by the ErrorContent attachment protocol — verify what interface ErrorContent expects from the replaced content). Add `.clone()` to GifContent before wiring the catch handler.
