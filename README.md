This repository contains the following components:

- `cbz-extension`: a CBZ viewer.  It parses the ZIP files purely in-browser, so it only supports CBZ, not CBR etc.  Supports 2up and right-to-left reading and zoom.  Why use this instead of a native app?  Firefox's session management is the biggest thing.  Significant pains have been taken to ensure that all your comics won't close when upgrading the extension.
- `cbz-native`: native components to help the CBZ viewer work on local files better.  If you use the browser's file picker, you can still view local files somewhat without this, but with it, you can open files from the command line and save your progress in long comics.
