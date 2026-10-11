# Research notes

Files in this directory are dated, point-in-time investigations: the design
rationale, measurements and source surveys behind the runtime's decisions.
They are not live operating instructions or status. Dates, pinned revisions,
source-backed design constraints and recorded experiments stay auditable;
sections named "current repo state", "current boundary" or similar describe
the repository when the note was written and may now be obsolete. Older notes
use the runtime's earlier working names and file paths from before the
workspace split ([ADR-0027](../adr/0027-split-the-runtime-package-from-the-documentation-application.md)).

Before acting on a research note:

1. read the note's date and scoped question;
2. verify repo-specific claims against current code and maintained tests;
3. use the affected maintained Compatibility Claim and its latest CI result
   for the current boundary, not the note;
4. treat a selected approach as current only if code or an accepted ADR still
   selects it;
5. do not restore deleted adapters, fallbacks or test harnesses merely because
   an older note describes them.

When a note's recommendation is implemented, keep the note as rationale and
link the implementation evidence (usually an ADR). Do not keep editing old
observations until they look like a current status document; write a new
dated note instead.
