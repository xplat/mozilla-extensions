# Makefile — build Firefox extensions as signed-ready .xpi packages
#
# Targets:
#   make              — build both extensions (default)
#   make cbz          — build cbz-viewer (dist/cbz-extension/ + dist/cbz-viewer.xpi)
#   make media        — build media-viewer (dist/media-extension/ + dist/media-viewer.xpi)
#   make clean        — remove dist/
#
# Development workflow:
#   1. make cbz  (or make media)
#   2. Load dist/cbz-extension/ in Firefox: about:debugging → Load Temporary Add-on
#   3. dist/cbz-viewer.xpi is the packaged form for distribution / signing
#
# Source directories keep manifest.json.in (not .json) so that Firefox will not
# try to load them directly as extensions.  The shared native-messaging.js lives
# in extension-shared/ and is copied into each dist/ extension during the build.

DIST         := dist
SHARED_NM_JS := extension-shared/native-messaging.js

CBZ_SRC   := cbz-extension
CBZ_DIST  := $(DIST)/cbz-extension
CBZ_XPI   := $(DIST)/cbz-viewer.xpi

MEDIA_SRC  := media-extension
MEDIA_DIST := $(DIST)/media-extension
MEDIA_XPI  := $(DIST)/media-viewer.xpi

CBZ_SRCS   := $(shell find $(CBZ_SRC)   -type f | sort)
MEDIA_SRCS := $(shell find $(MEDIA_SRC) -type f | sort)

.PHONY: all cbz media clean

all: cbz media

cbz: $(CBZ_XPI)

media: $(MEDIA_XPI)

# ── Assemble unpacked extension directories ───────────────────────────────────

$(CBZ_DIST): $(CBZ_SRCS) $(SHARED_NM_JS) | $(DIST)
	rm -rf $@
	cp -r $(CBZ_SRC) $@
	mv $@/manifest.json.in $@/manifest.json
	cp $(SHARED_NM_JS) $@/native-messaging.js

$(MEDIA_DIST): $(MEDIA_SRCS) $(SHARED_NM_JS) | $(DIST)
	rm -rf $@
	cp -r $(MEDIA_SRC) $@
	mv $@/manifest.json.in $@/manifest.json
	cp $(SHARED_NM_JS) $@/native-messaging.js

$(DIST):
	mkdir -p $(DIST)

# ── Pack into .xpi ────────────────────────────────────────────────────────────

$(CBZ_XPI): $(CBZ_DIST)
	cd $(CBZ_DIST) && zip -qr $(CURDIR)/$(CBZ_XPI) .
	@echo "Built: $(CBZ_XPI)"

$(MEDIA_XPI): $(MEDIA_DIST)
	cd $(MEDIA_DIST) && zip -qr $(CURDIR)/$(MEDIA_XPI) .
	@echo "Built: $(MEDIA_XPI)"

clean:
	rm -rf $(DIST)
