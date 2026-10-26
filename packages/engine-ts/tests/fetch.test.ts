import { expect, test } from "vite-plus/test";
import { createFetch, EngineHeaders, EngineResponse } from "../src/fetch";
import type { EngineHost } from "../src/host";

type HostFetch = EngineHost["fetch"];

function hostWith(fetch: HostFetch, blob: EngineHost["blob"] = () => null) {
	return createFetch({ fetch, blob });
}

const encoder = new TextEncoder();

test("requests send method, folded headers, and encoded bodies to the host", async () => {
	const requests: Parameters<HostFetch>[0][] = [];
	const fetch = hostWith(async (request) => {
		requests.push(request);
		return { status: 201, statusText: "Created", url: request.url, headers: [], body: new Uint8Array() };
	});
	await fetch("https://example.com/items", {
		method: "post",
		headers: { "X-Trace": "a", "x-trace": "b" },
		body: new URLSearchParams({ q: "λ" }),
	});
	expect(requests).toEqual([
		{
			method: "POST",
			url: "https://example.com/items",
			headers: [
				["content-type", "application/x-www-form-urlencoded;charset=UTF-8"],
				["x-trace", "a, b"],
			],
			body: encoder.encode("q=%CE%BB"),
		},
	]);
});

test("host responses expose status, headers, redirects, and body readers", async () => {
	const fetch = hostWith(async () => ({
		status: 200,
		statusText: "OK",
		url: "https://cdn.example.com/data.json",
		headers: ["content-type", "application/json", "x-count", "2"],
		body: encoder.encode('{"rows":[1,2]}'),
	}));
	const response = await fetch("https://example.com/data.json");
	expect(response.ok).toBe(true);
	expect(response.redirected).toBe(true);
	expect(response.url).toBe("https://cdn.example.com/data.json");
	expect([...response.headers]).toEqual([
		["content-type", "application/json"],
		["x-count", "2"],
	]);
	const copy = response.clone();
	expect(await response.json()).toEqual({ rows: [1, 2] });
	expect(await copy.text()).toBe('{"rows":[1,2]}');
	await expect(response.text()).rejects.toThrow("already been consumed");
});

test("blob URLs resolve in the engine without a host request", async () => {
	const blob = new Blob(["a,b\n1,2\n"], { type: "text/csv" });
	const fetch = hostWith(
		() => Promise.reject(new Error("blob URLs stay local")),
		(url) => (url === "blob:engine/1" ? blob : null),
	);
	const response = await fetch("blob:engine/1");
	expect(response.headers.get("content-type")).toBe("text/csv");
	expect(await response.text()).toBe("a,b\n1,2\n");
	await expect(fetch("blob:engine/2")).rejects.toThrow("Blob URL is unavailable");
});

test("aborting a request rejects with the signal reason", async () => {
	const fetch = hostWith(() => new Promise(() => {}));
	const controller = new AbortController();
	const pending = fetch("https://example.com/slow", { signal: controller.signal });
	controller.abort(new Error("stop"));
	await expect(pending).rejects.toThrow("stop");
});

test("constructed responses stream their bytes and infer text content types", async () => {
	const response = new EngineResponse("hello");
	expect(response.headers.get("content-type")).toBe("text/plain;charset=UTF-8");
	const reader = response.body!.getReader();
	expect(new TextDecoder().decode((await reader.read()).value)).toBe("hello");
	expect(new EngineHeaders([["Accept", "text/csv"]]).get("accept")).toBe("text/csv");
});
