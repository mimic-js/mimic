# Demo application pool

123 official starters and popular demos run one after another in the repository
playground in development mode. Which run, and the cause of every failure, are in
[`docs/research/2026-10-09-demo-app-pool.md`](../../../docs/research/2026-10-09-demo-app-pool.md);
the open causes are issues #706–#712.

- `build-pool.mjs` writes `pool.json` (not committed): repository, ref,
  directory, setup commands and dev command of each application.
- `run-pool.mjs <pool.json> <out-dir> [id-regex]` drives the playground at
  `PLAYGROUND_URL` (default `http://127.0.0.1:5173`) in Chromium and writes
  `results/`, `logs/` (terminal output) and `shots/` (screenshots) to `<out-dir>`.
  `SKIP_DONE=1` resumes; `CHROMIUM_PATH` picks the browser.
- `report.mjs <pool.json> <out-dir>` prints the Markdown table of a run; a
  `notes.json` beside it (`{ "<id>": { "category", "why", "status"? } }`) adds
  the cause of each failure.
