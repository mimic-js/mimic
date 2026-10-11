---
status: accepted
amends: ADR-0021 (when the Browser Package Replacements apply), ADR-0028 (when WASI binding companions are installed)
---

# Run a project's install scripts again after its replacements

The Command Proxy applies the Browser Package Replacements, and installs the
WASI binding companions (ADR-0028), once the manager has finished. The
manager runs the project's own `install`, `postinstall` and `prepare`
scripts before it finishes, so those scripts meet the packages as they were
before the replacements. In the
[demo pool rerun](../research/2026-10-09-demo-app-pool.md) that failed
two installs: Nuxt 4's `postinstall` (`nuxt prepare`) loads rolldown, whose
`@rolldown/binding-wasm32-wasi` companion was not installed yet, and Ant
Design Pro's (`max setup`) loads an esbuild version that had not been
swapped yet. The manager then exited non-zero, and the proxy, which applied
the replacements only after a successful install, never applied them.

## Decision

**When the manager changed the installed packages and failed in one of the
project's own install scripts, the replacements are applied anyway; if they
changed anything, the project's scripts run again, and their outcome is the
command's.**

- A failure is in the project's script when the manager's output names that
  script as the one that failed: npm's `command sh -c <script>`, pnpm's
  `<event>$ <script>`, Yarn 1's `$ <script>`. Under `--ignore-scripts`,
  `npm_config_ignore_scripts` or `ignore-scripts=true` in the project's
  `.npmrc`, nothing runs again.
- The scripts are the project's `install`, `postinstall`, `preprepare`,
  `prepare` and `postprepare`, in that order, run with `sh -c` in the
  project's directory as the manager runs them: the `node_modules/.bin`
  directories above it first on `PATH`, and `npm_lifecycle_event`,
  `npm_lifecycle_script`, `npm_package_json`, `npm_package_name`,
  `npm_package_version` and `INIT_CWD` set.
- "Changed anything" is a package swapped for another version or a
  companion installed. When nothing changed, the failure is not one the
  replacements could have caused, and the manager's exit code stands.
- A line on stderr says the scripts run again. If one of them fails, the
  command fails with the manager's exit code.
- The install scripts of a swapped dependency run as before (ADR-0021),
  with the same environment.

## Consequences

- An install whose own scripts load a replaced package or a WASI binding
  succeeds the way it does natively, at the cost of running those scripts
  twice when they failed the first time.
- A project script that fails for a reason of its own, in an install the
  replacements changed, runs twice before the command fails.
