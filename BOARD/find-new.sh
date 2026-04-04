#!/bin/sh
# Print titles of all issues in BOARD/issues/ that are not in triage.tsv
cd "$(dirname "$0")" || exit 1
ls issues/*.1.md 2>/dev/null | sed 's|.*/||;s|\.1\.md||' | LC_ALL=C sort | (exec 3<&0; cut -d'	' -f 3 triage.tsv | LC_ALL=C sort | LC_ALL=C join -v2 - /dev/fd/3)
