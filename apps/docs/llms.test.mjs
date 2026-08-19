import assert from "node:assert/strict";
import test from "node:test";

import { cleanLlmsFullText, validateLlmsLinks } from "./llms.mjs";

void test("validates production-base links against Docusaurus routes", () => {
	const source = [
		"- [Quickstart](/pyobservablejs/guide/quickstart/)",
		"- [Reference](/pyobservablejs/reference/)",
	].join("\n");

	assert.doesNotThrow(() =>
		validateLlmsLinks(source, "/pyobservablejs/", ["/pyobservablejs/guide/quickstart/", "/pyobservablejs/reference/"]),
	);
	assert.throws(
		() =>
			validateLlmsLinks(source, "/another-base/", ["/pyobservablejs/guide/quickstart/", "/pyobservablejs/reference/"]),
		/configured base URL/,
	);
});

void test("removes an execution fence that repeats a visible Python example", () => {
	const source = [
		"```marimo-config",
		'requires-python = ">=3.11,<3.15"',
		'dependencies = ["pyobservablejs"]',
		"```",
		"",
		"```python",
		"value = 42",
		"```",
		"",
		"```python marimo echo=false server-output=false",
		"value = 42",
		"```",
		"",
		"Result.",
		"",
		"Continue with [the guide](guide/next.mdx), [details](guide/next.mdx#details), or [the source](https://example.test/source).",
	].join("\n");

	assert.equal(
		cleanLlmsFullText(source),
		[
			"```python",
			"value = 42",
			"```",
			"",
			"Result.",
			"",
			"Continue with the guide, details, or [the source](https://example.test/source).",
		].join("\n"),
	);
});

void test("rejects a unique marimo execution fence", () => {
	const source = [
		"```python",
		"value = 42",
		"```",
		"",
		"```python marimo echo=false server-output=false",
		"value = 43",
		"```",
	].join("\n");

	assert.throws(() => cleanLlmsFullText(source), /marimo execution cell with no matching visible Python example/);
});
