# Deploying the site

The site (`apps/site`: the landing page, the documentation and the
playground) is a static Vite build. It is deployed on Vercel from the root
[`vercel.json`](../vercel.json); nothing runs on the server, so Vercel's
function and edge limits do not apply. This document is the setup of that
deployment. The headers and the preview origin it configures are the ones
the [package README](../packages/runtime/README.md#setup) requires of any
host.

## The Vercel project

Create one Vercel project for the repository with these settings. All but
the first three come from `vercel.json`, which overrides the dashboard.

| Setting | Value |
| --- | --- |
| Root Directory | the repository root (leave it empty) |
| Node.js Version | 22.x, as in CI |
| Environment variable `VITE_PREVIEW_ORIGIN` | the preview origin, see below; available at build time |
| Framework Preset | Other (`"framework": null`) |
| Install Command | `npx --yes pnpm@11.7.0 install --frozen-lockfile` |
| Build Command | `NODE_OPTIONS=--max-old-space-size=4096 npx --yes pnpm@11.7.0 nx run site:build` |
| Output Directory | `apps/site/dist` |

The workspace needs pnpm 11 (CI pins 11.7.0). Vercel picks pnpm 9 or 10 for
a `lockfileVersion: '9.0'` lockfile, and an overridden install command that
starts with a bare `pnpm` runs the oldest pnpm of the build image
([package managers](https://vercel.com/docs/package-managers)), so both
commands run the pinned release through `npx`. `npx` puts that `pnpm` first
on the `PATH` of the commands it starts, so the package scripts Nx runs use
it too. The alternative is Corepack: a `packageManager` field in the root
`package.json` and `ENABLE_EXPERIMENTAL_COREPACK=1` in the project.

`nx run site:build` builds `@mimic-js/runtime` first (`^build`), then the site.
The site bundles the Monaco editor, whose build peaks above 3 GB of memory,
so `NODE_OPTIONS` raises Node's heap limit; without it the build stops with
"JavaScript heap out of memory". CI sets the same variable.

### Headers

Every response carries four headers (`"source": "/(.*)"`):

| Header | Why |
| --- | --- |
| `Cross-Origin-Opener-Policy: same-origin` | with the next one, makes the page cross-origin isolated, which `SharedArrayBuffer` needs |
| `Cross-Origin-Embedder-Policy: require-corp` | the same, for the page and for the package's assets, which the runtime's frame and workers load with the page's policy |
| `Cross-Origin-Resource-Policy: cross-origin` | the site loads the Runtime Host document and the package's assets from the preview origin |
| `Service-Worker-Allowed: /` | on a wildcard preview origin, each endpoint's Service Worker, a script under `/assets/`, takes the root of its origin |

Sending them with every response, static assets included, is the rule the
package README recommends; `vercel.json` headers apply to the static files
of the output directory as well as to rewritten paths.

### Rewrites

```json
"rewrites": [
  { "source": "/github-archive/:path*", "destination": "https://codeload.github.com/:path*" },
  { "source": "/(.*)", "destination": "/index.html" }
]
```

- `/github-archive/<owner>/<name>/tar.gz/<ref>` is how the playground
  downloads a repository: codeload.github.com sends no CORS headers, so the
  page reads the archive through its own origin, as the Vite dev and preview
  servers proxy it in development. Codeload answers that path with the
  archive itself (`200`, `application/x-gzip`), not a redirect, and the
  playground sends no query string. Where the archive cannot be read this
  way, the playground falls back to the GitHub API and
  raw.githubusercontent.com (`apps/site/src/playground/github-archive.ts`).
- `/(.*)` → `/index.html` is the single-page application's fallback for
  `/docs/api`, `/playground` and every other route. Vercel checks the file
  system before rewrites
  ([routing order](https://vercel.com/kb/guide/why-is-my-deployed-project-giving-404)),
  so `/assets/*`, `/mimic-mark.svg` and the package's files are served as
  files. The 404 page is the application's own.

## The preview origin

The playground runs repositories nobody reviewed. Without a preview origin,
their processes and the documents they publish run on the site's own origin
and hold its ambient authority: cookies, storage, and the page itself through
`window.parent`
([ADR-0032](adr/0032-serve-published-endpoints-from-a-preview-origin.md), the
package README's "What this does and does not contain"). The site therefore
boots with `previewOrigin` set from `VITE_PREVIEW_ORIGIN`, which Vite reads at
build time: changing it needs a new build.

### A wildcard (the deployment)

```sh
VITE_PREVIEW_ORIGIN=https://*.mimicjs.com
```

A wildcard serves each Published Endpoint from the root of an origin of its
own ([ADR-0044](adr/0044-serve-each-published-endpoint-from-an-origin-of-its-own.md)),
which client-side routers such as Angular's and Nx's need. The site is
`https://mimicjs.com`; the Runtime Host document, with the processes, the
Compile Cache and the package-manager cache, runs on the wildcard's fixed
label, `https://mimic.mimicjs.com`, and an endpoint of port 5173 on
`https://<epoch>--5173.mimicjs.com/`. The apex and `www` are the site's; every
other label of the domain belongs to the previews, so host nothing else
under it.

The site and the previews share one registrable domain, so they are
same-site: a project's code on an endpoint origin can set a cookie with
`Domain=mimicjs.com`, which the browser then sends to the site, and the
same-site protections between them do not apply. The site is static, with no
account, session or API, so nothing is at stake today. Before the site gets
any of those, move the previews to an apex domain of their own (for example
`mimic-preview.com`), which keeps them cross-site: one variable and a
redeploy. As optional hardening, a preview domain can be listed on the
[Public Suffix List](https://publicsuffix.org/), which makes every
`<epoch>--<port>` label a site of its own, so endpoints of different
containers cannot share cookies either.

To set the domain up in Vercel:

1. At the registrar, set the domain's nameservers to `ns1.vercel-dns.com`
   and `ns2.vercel-dns.com`. Vercel issues certificates for a wildcard
   domain only when the domain uses its nameservers.
2. In the project's **Settings → Domains**, add `mimicjs.com`,
   `www.mimicjs.com` (redirecting to the apex) and `*.mimicjs.com`. The
   wildcard certificate does not cover the apex, which gets its own.
3. Set `VITE_PREVIEW_ORIGIN=https://*.mimicjs.com` for the Production
   environment and redeploy.

The same build must answer on every one of those hostnames, at the same
paths: the site loads `runtime-host.html` and the package's workers from
`mimic.mimicjs.com`, and each endpoint origin loads the package's Service
Worker and `published-endpoint-origin.html` from itself. One Vercel project
with all the domains assigned to it does that, and its headers apply on every
hostname.

Preview deployments (Vercel's per-branch URLs) are built with their own
environment's variables. Leave `VITE_PREVIEW_ORIGIN` unset for them, or
point it at hostnames that serve that deployment: the page loads the
Runtime Host document and the package's assets from the preview origin at
its own build's hashed paths, which another build does not have.

### A single preview origin

Without wildcard DNS, one hostname works too:

```sh
VITE_PREVIEW_ORIGIN=https://preview.mimicjs.com
```

Add that domain to the same project. Endpoints are then served under a
directory of that origin, and client-side routers that read
`location.pathname` (Angular, Nx, React Router 7, SolidStart and others)
render their 404 page or fail to hydrate (ADR-0044); the playground marks the
Nx example as partly working for this reason.

### No preview origin

With `VITE_PREVIEW_ORIGIN` unset or empty, the site's own origin serves the
runtime and the endpoints. It works for any stack a single origin works for,
without isolating the projects the playground opens from the site.

## Checking a deployment

- `curl -I https://mimicjs.com/docs/api` returns `200` with the four headers.
- `curl -I https://mimic.mimicjs.com/` returns the same headers.
- In the playground, `/playground?example=vite8-react-ts` downloads the
  repository through `/github-archive`, installs, and shows the preview from
  an `https://<epoch>--5173.mimicjs.com/` frame.
