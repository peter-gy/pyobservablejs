// Check the LLM text views that the documentation build writes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (name) => readFileSync(new URL(`./build/${name}`, import.meta.url), "utf8");

assert.ok(read("llms.txt").trim(), "build/llms.txt is empty");
const full = read("llms-full.txt");
assert.ok(full.trim(), "build/llms-full.txt is empty");
assert.doesNotMatch(full, /^```marimo-config$/m, "llms-full.txt keeps a marimo-config fence");
assert.doesNotMatch(
	full,
	/^```python marimo echo=false server-output=false$/m,
	"llms-full.txt keeps a hidden marimo execution fence",
);
assert.doesNotMatch(full, /\]\([^)]*\.mdx(#[^)]*)?\)/, "llms-full.txt links to MDX source files");
