#!/bin/sh
# Print titles of all issues in BOARD/issues/ that are not in triage.tsv
cd "$(dirname "$0")/.." || exit 1
ls BOARD/issues/*.1.md 2>/dev/null | sed 's|.*/||;s|\.1\.md||' | while read -r title; do
    grep -qF "	$title	" BOARD/triage.tsv || echo "$title"
done
