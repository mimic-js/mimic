---
status: accepted
---

# Keep Angular development owned by Angular CLI

Mimic will support Angular development through two published Angular CLI Exact Graphs: Angular 21 with its publisher-pinned embedded Vite 7, and Angular 22 with its publisher-pinned embedded Vite 8. `ng serve` delegates to each graph's installed Angular build system, which owns application compilation and its encapsulated Vite development server; standalone Vite and Angular may therefore capture different Vite patches. Direct Angular-on-Vite configuration, dependency overrides or deduplication, Angular-specific runtime behavior, and framework adapters are excluded because they would prove a Mimic-owned substitute rather than the upstream Angular development workflow.

Both maintained fixtures are minimal standalone client-rendered applications using `@angular/build:application` and SCSS, without a router, SSR, prerendering, service workers, localization, or legacy webpack builders. One shared version-parameterized `AngularDevSuite` owns frozen npm installation, real `ng serve`, initial render through a Published Endpoint, template and component/global SCSS HMR, template and SCSS error recovery in the same process, hard reload, stop, endpoint release, teardown, cold reboot, and warm-cache restart. HMR must preserve the browser document without full reload; application state is preserved only when the same edit against the same Exact Graph preserves it in the upstream host reference.

Angular claims run the build system's default worker policy, derived from `os.availableParallelism()`, without `NG_BUILD_MAX_WORKERS` or another fixture-specific concurrency override; insufficient worker capacity is repaired as a package-neutral runtime capability. They also use the default filesystem watcher without `--poll`, polling environment variables, or fixture-specific watcher configuration; missed updates are repaired in the package-neutral VFS and watcher lifecycle.

Each Angular Exact Graph retains the published defaults for dependency prebundling and Angular CLI disk caching, with no inherited `CI` variable that would disable the local cache. Its evidence starts without `.angular/cache`, proves the cold `ng serve`, render, and HMR path, then stops and starts the same workspace to prove warm-cache render and HMR. A separate pristine-container reboot proves that success does not depend on state outside the mounted fixture and runtime-owned package caches.

Production `ng build`, SSR, prerendering, in-runtime `ng new` scaffolding, HTTPS and certificate handling, proxy configuration, custom headers, external host exposure beyond Published Endpoints, and inspector/debugger support are independent compatibility surfaces and are not part of the initial Angular development claim. Maintained fixtures are curated from upstream-generated workspaces and reviewed lockfiles before frozen installation.
