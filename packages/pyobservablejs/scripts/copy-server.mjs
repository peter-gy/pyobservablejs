import { cp, rm } from "node:fs/promises";
const target = new URL("../src/observablejs/static/server/", import.meta.url);
await rm(target, { recursive: true, force: true });
await cp(new URL("./dist/", import.meta.resolve("@pyobservablejs/server/package.json")), target, { recursive: true });
