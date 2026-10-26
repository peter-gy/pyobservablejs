# Notebook engine

`@pyobservablejs/engine-ts` builds the headless notebook service for two hosts:

| Output                             | Host                                                      | Python owner                        |
| ---------------------------------- | --------------------------------------------------------- | ----------------------------------- |
| `packages/engine-rust/bundle/*.js` | V8 isolate in the `pyobservablejs-engine-rust` Rust crate | `observablejs._host.EmbeddedEngine` |
| `dist/browser/*.js`                | Headless Chromium page driven by Playwright               | `observablejs._chromium`            |

Both hosts run `createService` from `service.ts`. It owns commands, notebook
source requests, snapshots, and diagnostics. The package imports runtime
execution and the shared Python codecs from `@pyobservablejs/protocol`. It has
no dependency on anywidget or the widget adapter.

## Embedded entry

`embedded.ts` is the V8 bundle entry. Rust evaluates `bootstrap.js` first, which
installs the web platform globals from `deno_web` and the host operations. Module
order inside the bundle then fixes the remaining setup:

1. `prelude.ts` claims the host operations and installs `fetch`, `Headers`,
   `Request`, `Response`, and Node's immediate timers.
2. `dom.ts` creates a Happy DOM `GlobalWindow` before Notebook Kit loads, since
   Notebook Kit reads `document` at import time. DOM resource loading, script
   evaluation, and page navigation are disabled.
3. `embedded.ts` sends `{type: "ready"}` and dispatches each JSON request in
   arrival order until Python closes the engine.

Responses cross the host boundary as a JSON header string plus `Uint8Array`
buffers. Request IDs correlate concurrent reads. Notebook source requests travel
in the opposite direction over the same channel.

Happy DOM imports Node built-ins. `vite.config.ts` aliases each one to a shim in
`src/node/` backed by web APIs. Paths that need Node I/O, such as Happy DOM's own
fetch and WebSocket, raise when called. Vite keeps lazy chunks separate, and Rust
embeds every chunk and serves it from `pyobservablejs:/<file>.js`.

`fetch.ts` implements `fetch` over the host's network operation. Rust applies
the notebook network policy, follows redirects, and returns complete bodies.
`blob:` URLs resolve in the isolate.

## Chromium entry

`browser.ts` mounts notebooks with `mountNotebook` in a real page. Python serves
the page and its modules from a routed virtual origin and receives each response
as one frame posted to `/response`. `encodeFrame` from the protocol package
writes that frame.

## Build

```sh
pixi run pnpm --filter @pyobservablejs/engine-ts build
```

The V8 bundle goes to `packages/engine-rust/bundle/`, where the Rust
engine crate embeds it. The Chromium page goes to `dist/browser/`, and the
Python package build copies it into `observablejs/static/chromium/`.
