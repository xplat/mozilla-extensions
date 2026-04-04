The board consists of titled and triaged issues.  Issues have a [a-z0-9-]+ title, and are stored as 3 files in `BOARD/issues`:
- title.1.md - a brief 1-sentence description.
- title.2.md - details needed for scoping and triage, including known-relevant line-ranges, definitions, or greps -- prefer to specify in a way that's robust against concurrent changes if possible.
- title.3.md - details relevant for implementation.  Eventually this becomes the implementation plan.

Triage lives in `BOARD/triage.tsv`.  The columns are priority, lifecycle stage (new/scoped/planned), title, brief comment.  A `sort BOARD/triage.tsv | head` gets the highest-priority issues and similar shell tricks are available, including `BOARD/find-new.sh` which finds the titles of all untriaged issues.

Finished issues are moved to `BOARD/done/`, removed from triage.tsv, and may have a brief implementation report in `issue.4.md`.
