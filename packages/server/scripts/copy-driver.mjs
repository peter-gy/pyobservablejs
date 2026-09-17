import { cp } from "node:fs/promises";
const driver = new URL("./", import.meta.resolve("playwright-core/package.json"));
await cp(driver, new URL("../dist/driver/", import.meta.url), { recursive: true });
