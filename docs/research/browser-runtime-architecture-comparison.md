# Research: browser runtime architecture comparison

> Snapshot note: source findings and dated evidence are retained, but repo-specific
> “current state” statements may be obsolete. Verify them against current code,
> tests, issues, and [`compatibility-status.md`](../compatibility-status.md). See
> [the research status rules](./README.md).

Date: 2026-06-28

## Why this research exists

The roadmap explicitly calls for research on comparable browser runtimes and sandboxes before the repository locks in its runtime architecture:

- `Research comparable browser runtimes and sandboxes... and publish an architecture comparison plus ADR for this repository.`
- `Publish an architecture comparison of similar browser runtimes/sandboxes using primary documentation and available source code; record process isolation, filesystem, module execution, package installation, networking, preview routing, caching, security, and extensibility tradeoffs.`

This document covers the comparison part. It does not replace the future ADR. Its job is to narrow the decision space for this repository, whose target is still a WebContainers-like browser runtime that can run Node.js code and real frontend toolchains without cloud VMs.

## Repo-specific context

- [`../../docs/roadmap-alignment.md`](../../docs/roadmap-alignment.md) already commits the project to a browser-resident kernel, process scheduler, POSIX-like VFS, package-manager execution, Node-compatible loader, and virtual HTTP/WebSocket preview serving.
- The current repo is already on a JS-compatibility path, not an x86/Linux virtualization path.
- The open architecture question is therefore not "browser or cloud?" but "which runtime boundaries should this repo copy, and which classes of runtime should it avoid imitating?"

## Source set

Primary sources used here:

- WebContainers introduction and guides:
  - https://webcontainers.io/guides/introduction
- Sandpack architecture and bundler docs:
  - https://sandpack.codesandbox.io/docs/architecture/overview
  - https://sandpack.codesandbox.io/docs/guides/hosting-the-bundler
  - https://sandpack.codesandbox.io/docs/advanced-usage/serving-static-files
- Nodebox runtime README:
  - https://github.com/Sandpack/nodebox-runtime/blob/main/README.md
- CheerpX overview:
  - https://cheerpx.io/docs/overview
- WebVM README:
  - https://github.com/leaningtech/webvm/blob/main/README.md
- BrowserPod overview:
  - https://browserpod.io/docs/overview

## Evaluation frame

For this repository, the useful comparison dimensions are:

- process isolation and scheduling
- filesystem fidelity and persistence model
- module execution model
- package installation model
- networking and preview routing
- cache/distribution model
- security boundary
- extensibility toward more stacks without rewriting the public API

## Source-backed findings

### 1. WebContainers are the closest product target, but their public docs describe outcomes more than internals

WebContainers describe themselves as a browser-based runtime for executing Node.js applications and operating-system commands inside the browser tab. Their public positioning emphasizes native Node.js toolchains in-browser, fast startup, local execution, and strong browser-contained security.

For this repository, that matters more than the exact internals. The externally visible target already matches the roadmap:

- browser-resident Node execution
- real package-manager and CLI workflows
- process-owned preview servers
- no dependence on cloud VMs for normal execution

What the public docs do not fully provide is a reusable internal architecture blueprint. They are a product target and behavioral baseline, not a detailed layering spec.

Implication for this repo: keep using WebContainers as the compatibility target, but do not wait for their docs to answer internal design questions about process tables, preview transport, or package caching boundaries.

## 2. Sandpack is editor/preview architecture first, runtime second

Sandpack's architecture docs describe a UI/provider/client/bundler split:

- `Sandpack React` manages UI state
- `sandpack-client` selects a client type
- a separate bundler processes the sandbox and sends updates back

The bundler docs also explain that the bundler is intentionally hosted in an iframe under another subdomain for security, uses workers for transpilation, supports code splitting for on-demand compiler loading, and relies on a Service Worker for offline reuse. Static file serving is explicitly still a beta Service Worker feature with limitations.

That is a useful contrast with this repository:

- Sandpack optimizes for embeddable live-editing UX.
- Its architecture tolerates an externally hosted bundler and iframe isolation because its product center is preview composition, not high-fidelity Node/process parity.
- The service-worker-backed static serving model is narrower than the roadmap target here, where preview traffic should ultimately come from a process-owned virtual server path.

Implication for this repo: borrow Sandpack's host/UI separation and its security posture for preview surfaces, but do not copy its external bundler dependency or treat Service Worker static serving as the final architecture for Node/Vite server workloads.

## 3. Nodebox is the clearest example of the "Node-compatible shim runtime" strategy

Nodebox explicitly says it is not emulating Node.js. Instead, it implements as much of the Node.js API as practical on top of browser APIs, uses an internal dependency manager backed by the Sandpack CDN, and accepts browser-driven limitations. The README also lists specific limits such as:

- no N-API modules
- no external-IP `net.Socket` support
- no synchronous `exec`/`spawn`
- incomplete `async_hooks`

It also describes Nodebox as two parts:

- a runtime environment that evaluates code
- a preview environment that serves the evaluation result

That makes Nodebox highly relevant because the current repository is still somewhat close to this class of system: targeted Node compatibility, browser-native abstractions, and selective API coverage.

Implication for this repo:

- Nodebox validates the viability of the compatibility-layer approach.
- It also shows the ceiling of that approach if architecture stays too ad hoc.
- If this repository remains a pure API-by-API shim without strong runtime boundaries, it is likely to inherit the same long-term blind spots: partial process semantics, incomplete networking, and package/runtime compatibility gaps that accumulate per module.

## 4. CheerpX and WebVM represent the opposite end: high-fidelity native/Linux virtualization

CheerpX describes itself as x86 virtualization for running executables and operating systems fully client-side, including unmodified native binaries and Linux distributions. It exposes a Linux-compatible syscall interface and uses interpreter plus JIT compilation to WebAssembly.

WebVM is the productized demonstration of that approach:

- Linux ABI-compatible
- unmodified Debian userspace
- virtual block-based filesystem
- Linux syscall emulation
- Tailscale-backed networking with real reach into private/public networks, but still with some low-level limitations such as missing ICMP `ping`

This class of runtime has a major advantage: it collapses many compatibility problems by running real native/Linux software instead of recreating Node behavior piecemeal.

But for this repository, it is also the wrong near-term shape:

- startup weight is higher
- runtime images, syscall emulation, and full virtualization are much larger architectural commitments than the current codebase
- the repo would effectively stop being a Node/browser runtime project and become a VM platform

Implication for this repo: use CheerpX/WebVM as evidence for what becomes possible when JS-compatibility ceilings become unacceptable, but do not pivot the current roadmap to x86/Linux virtualization. That would invalidate too much existing work and move the project into a different product category.

## 5. BrowserPod is the most useful "next-step architecture" reference

BrowserPod sits between Nodebox-style shims and WebVM-style full virtualization.

Its docs describe:

- complete runtime engines compiled to WebAssembly, starting with Node.js
- Linux-compliant syscall targeting rather than limited JS shims
- execution inside WebWorkers for multi-threading and process isolation
- a block-based streaming virtual filesystem with on-demand disk images
- per-port preview exposure through "Portals"
- an explicit roadmap from Node.js toward shell tools, more languages, and eventually Linux-class workloads powered by CheerpX

For this repository, BrowserPod is important not because it should be copied wholesale, but because it demonstrates a staged migration path:

1. start with a language/runtime-specific engine
2. isolate execution in workers
3. use a more faithful filesystem and port model
4. only later broaden into a more universal workload platform

Implication for this repo: BrowserPod's layering is the closest architectural inspiration for the next two roadmap phases, especially worker-backed process isolation, stronger filesystem ownership, and port-owned preview routing.

## Comparison matrix

| Runtime | Core strategy | Process isolation | Filesystem model | Package/install model | Networking and preview | Security boundary | Fit for this repo |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WebContainers | Browser-native Node runtime with high product fidelity | Public docs imply runtime-level isolation; exact internals not fully documented publicly | Browser-managed runtime FS with snapshots/export in API | Real Node/package-manager workflows are part of the contract | Preview served by process-owned server semantics | Browser tab containment plus cross-origin isolation baseline | Primary behavioral target |
| Sandpack | UI toolkit plus bundler/client architecture | Iframe + worker-heavy bundler isolation | File map plus template/preset oriented sandbox state | Dependency setup flows through Sandpack/bundler model | Iframe preview; static serving currently Service Worker based | Different subdomain iframe to isolate execution | Useful host/preview separation reference, not runtime target |
| Nodebox | Browser API based Node-compatible runtime | Runtime and preview are separate parts, but not full OS/process parity | Practical compatibility FS, optimized for fast browser sandboxes | Internal dependency manager plus Sandpack CDN caching | Preview environment serves evaluated result; networking intentionally limited | Browser sandbox with selective Node API reimplementation | Strong warning and useful benchmark for shim-runtime limits |
| CheerpX / WebVM | Native x86/Linux virtualization in browser | VM/process semantics come from virtualized Linux stack | Virtual block filesystem and Linux-compatible interfaces | Real native/Linux toolchains, not recreated JS install semantics | VM-style networking, including Tailscale in WebVM | Browser sandbox around a virtualized machine | Too heavy as the current direction, but useful escape hatch model |
| BrowserPod | Wasm-compiled runtime engines with worker/process isolation | Explicit WebWorker multi-threading and process isolation | Block-based streaming POSIX VFS | Runtime-engine-centric; roadmap grows language/tool coverage over time | Portals map listening ports to preview URLs | Client-side execution with stronger runtime boundary than JS shims | Best comparative reference for next architectural steps |

## What this means for this repository

### Main conclusion

This repository should stay on the WebContainers-compatible track, but it should evolve away from a Nodebox-style "incremental API shim" architecture and toward a BrowserPod-style layered runtime boundary.

That means:

- keep the existing browser-native/public-API direction
- do not pivot to full Linux/x86 virtualization
- strengthen process, filesystem, port, and package boundaries now, before more framework support makes the architecture harder to change

### Architecture guidance inferred from the comparison

This section is an inference from the sources plus the current roadmap.

The target architecture should separate at least these layers:

- public `Mimic` facade
- runtime kernel and lifecycle owner
- process manager and worker execution boundary
- VFS plus metadata/watch/snapshot services
- Node loader/stdlib execution contexts
- package-manager/registry/cache policy
- virtual sockets plus HTTP/WebSocket preview bridge
- diagnostics and compatibility reporting

That layering is consistent with the current roadmap and is the safest way to avoid converging on a monolithic compatibility shim.

## Recommended decisions before the ADR

### Decision 1. Do not adopt external-bundler architecture as the end state

Sandpack's external bundler and iframe isolation are good embedding techniques, but they should remain host-app concerns. The core runtime here should continue moving toward process-owned servers inside the browser runtime.

### Decision 2. Treat Nodebox as a cautionary lower bound, not the target

If a proposed shortcut increases the amount of one-off Node API reimplementation without improving runtime boundaries, it is probably moving the repo toward Nodebox's limitations instead of toward WebContainers-like fidelity.

### Decision 3. Keep CheerpX/WebVM as a future escalation path only

If future goals require native binaries, full Linux distributions, or general multi-language workloads, the repo may eventually need a virtualization-backed product line. That is not the correct move for the current roadmap.

### Decision 4. Use BrowserPod-style worker/process boundaries as the immediate architectural direction

The next ADR should explicitly define:

- what owns the process table
- what owns port/listen state
- what crosses the worker boundary
- whether VFS mutations are authoritative in one kernel service or mirrored peer-to-peer
- how package cache and preview routing stay runtime-scoped instead of demo-scoped

## Concrete roadmap impact

This research most directly informs these roadmap areas:

- Section 2: browser runtime kernel
- Section 4: process, shell, and terminal streams
- Section 5: package managers and registry behavior
- Section 8: networking and preview ownership
- Section 16: layered runtime architecture and comparative research

Recommended follow-up checklist decomposition after this research:

- write the ADR for target layering and migration constraints
- define the runtime-owned process table and port registry
- define authoritative VFS ownership across workers
- define the preview transport boundary for HTTP and WebSocket, not only HTML/static responses
- define package-cache ownership and invalidation independent of the demo app shell

## Bottom line

The strongest architecture signal from the ecosystem is:

- WebContainers define the product bar
- Sandpack defines useful embedding and preview isolation techniques
- Nodebox shows the practical ceiling of pure compatibility shims
- CheerpX/WebVM show the virtualization escape hatch
- BrowserPod shows the most relevant next architectural step for this repository

So the repo should continue as a browser-native Node runtime, but with harder worker/kernel/VFS/network boundaries and without drifting into either an iframe-bundler product or a full VM platform.
