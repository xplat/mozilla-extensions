Wanted:
- An option to open in a named tab group rather than the top window.
- An option to open in the background (don't make the new tab active).
- An option for delayed open (create a discarded tab, implies previous option).

This affects both the frontend (background script only) and the backend.  Most of this will live in code shared between the two extensions, and we should be trying to put most new code there, like shared option parsing infrastructure and shared code to turn this into tabs.create options.
