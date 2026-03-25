# Makefile — build Firefox extensions as signed-ready .xpi packages
#
# Targets:
#   make              — build both .xpi files (default)
#   make cbz          — build cbz-viewer.xpi
#   make media        — build media-viewer.xpi
#   make clean        — remove built .xpi files
#
# Output: dist/cbz-viewer.xpi  dist/media-viewer.xpi
#
# An .xpi is just a ZIP archive of the extension directory contents
# (manifest.json at the root, no parent directory entry).

DIST := dist

CBZ_XPI   := $(DIST)/cbz-viewer.xpi
MEDIA_XPI := $(DIST)/media-viewer.xpi

CBZ_SRCS   := $(shell find cbz-extension   -type f | sort)
MEDIA_SRCS := $(shell find media-extension -type f | sort)

.PHONY: all cbz media clean

all: cbz media

cbz: $(CBZ_XPI)

media: $(MEDIA_XPI)

$(CBZ_XPI): $(CBZ_SRCS) | $(DIST)
	cd cbz-extension && zip -qr --must-match ../$(CBZ_XPI) $(patsubst cbz-extension/%,%,$(CBZ_SRCS))
	@echo "Built: $(CBZ_XPI)"

$(MEDIA_XPI): $(MEDIA_SRCS) | $(DIST)
	cd media-extension && zip -qr --must-match ../$(MEDIA_XPI) $(patsubst media-extension/%,%,$(MEDIA_SRCS))
	@echo "Built: $(MEDIA_XPI)"

$(DIST):
	mkdir -p $(DIST)

clean:
	rm -f $(CBZ_XPI) $(MEDIA_XPI)
	@rmdir $(DIST) 2>/dev/null || true
