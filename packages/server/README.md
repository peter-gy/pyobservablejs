# Deno server adapter

`@pyobservablejs/server` bundles the headless evaluator and a DOM host into the
Python distribution. It imports runtime execution and shared Python codecs. It
has no dependency on anywidget or the widget adapter.

The Deno entry point creates a Happy DOM document before loading Notebook Kit, whose
runtime reads `document` at module initialization. DOM resource loading and page
navigation are disabled. Deno owns module loading, fetch, timers, and permissions.

The process exchanges length-prefixed UTF-8 JSON headers over stdin and stdout.
A response header contains binary buffer lengths, followed by those buffers.
Request IDs correlate concurrent reads. Notebook source requests travel in the
opposite direction over the same connection. Console messages use stderr.

Python starts the binary from the optional `deno` distribution, ignores local
Deno and npm configuration, and enables lazy dynamic imports. The process can
read its bundled modules. Network access is enabled by default; callers can select offline execution or
restrict requests to named hosts. Timeouts and cancelled asynchronous reads terminate
the process to bound synchronous loops as well as asynchronous work. The next
read starts a fresh evaluation. Request framing allocates each declared frame
once and accepts arbitrary stream chunk boundaries.

Build with `vp run @pyobservablejs/server#build`. The Python build copies the
complete output directory into `observablejs/static/server/`.

With `engine="chromium"`, Deno runs the bundled Playwright driver and launches
its matching Chromium. The driver installs Chromium into its cache when missing.
A routed virtual origin serves packaged browser assets and forwards framed binary
responses from the page. No HTTP listener or widget model is involved. Notebook
network policy is enforced through context request and WebSocket routes.

`service.ts` owns commands, source requests, snapshots, and diagnostics for both
hosts. `main.ts` connects it to Deno stdin. `browser.ts` connects it to browser
requests. `chromium.ts` owns browser launch, installation, asset routing, capture,
and teardown. The Python process transport is identical for both engines.
