// Every wheel serves the Chromium engine page from observablejs/static/chromium/.
import { cp, rm } from "node:fs/promises";

const page = new URL("./dist/browser/", import.meta.resolve("@pyobservablejs/engine-ts/package.json"));
const target = new URL("../src/observablejs/static/chromium/", import.meta.url);
await rm(target, { recursive: true, force: true });
await cp(page, target, { recursive: true });
