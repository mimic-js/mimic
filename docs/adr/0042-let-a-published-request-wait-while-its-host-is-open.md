---
status: accepted
amends: ADR-0033 (how long the Service Worker waits for the Runtime Host Document to answer a request)
---

# Let a published request wait while its host is open

The Published Endpoint Service Worker passed each request to the instance's
Runtime Host Document and answered `504` when no response head came back
within 35 seconds. The deadline existed so a request would not wait forever
on a host document that had gone without closing its connection. It also
cut off every server that is slow to answer: webpack-dev-server holds each
request until its first build ends, and Create React App 5's first build
takes longer than that in the browser, so its first page was a `504` that
Chromium shows as "refused to connect"
([demo pool rerun, 2026-10-09](../research/2026-10-09-demo-app-pool.md)).
A browser in front of a real server waits for the server.

## Decision

**A published request waits for its response for as long as the host
document serving it is open.** The Service Worker records the client id of
the window that connected as an instance's host. While a request waits, the
worker looks for that client among the open windows every 10 seconds and
answers `504` once it is gone. A host whose client id is unknown keeps the
35-second deadline. The wait ends with a `504` after 4.5 minutes in any
case: the browser stops a Service Worker whose fetch event is still pending
after five minutes, and with it every response and stream the worker is
serving (Nuxt's loading page lost its progress stream, and its reload, to a
navigation the playground had abandoned).

## Consequences

- A dev server's first page arrives when its first build ends, however long
  that takes, instead of turning into an error page the server never sent.
- A request to a server that never answers waits like it would in front of a
  real server, until the page gives up, or for 4.5 minutes.
- A host that closed is noticed within 10 seconds instead of 35.
