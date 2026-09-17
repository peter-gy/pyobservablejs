import { expect, test } from "vite-plus/test";
import { isString } from "@pyobservablejs/runtime/values";
import { isRecord } from "../src/model";
import { connectNotebookSources } from "../src/imports";
import { createSession } from "./testing";

test("correlates notebook sources and ignores cancelled replies", async () => {
	const model = createSession({});
	const lifetime = new AbortController();
	const resolveNotebook = connectNotebookSources(model, lifetime.signal);
	const first = new AbortController();
	const cancelled = resolveNotebook("@example/a", { signal: first.signal });
	const failed = expect(cancelled).rejects.toThrow("cancelled");
	const successful = resolveNotebook("@example/b", { signal: lifetime.signal });
	const messages = model.sentMessages().map((message) => message.content);
	const one = messages.find((message) => isRecord(message) && message.specifier === "@example/a");
	const two = messages.find((message) => isRecord(message) && message.specifier === "@example/b");
	if (!isRecord(one) || !isRecord(two)) throw new Error("Expected source requests");
	first.abort();
	await failed;
	model.receiveCustom({
		kind: "observablejs:import",
		protocol: 1,
		type: "response",
		id: one.id,
		result: { source: "ignored" },
	});
	model.receiveCustom({
		kind: "observablejs:import",
		protocol: 1,
		type: "response",
		id: two.id,
		result: { source: "<notebook></notebook>" },
	});
	expect(await successful).toEqual({ source: "<notebook></notebook>" });
	const disposed = resolveNotebook("@example/c", { signal: lifetime.signal });
	const lastRequest = model.sentMessages().at(-1)?.content;
	if (!isRecord(lastRequest) || !isString(lastRequest.id)) throw new Error("Expected the final source request");
	const closed = expect(disposed).rejects.toThrow("closed");
	lifetime.abort();
	await closed;
	const cancellations = model
		.sentMessages()
		.map(({ content }) => content)
		.filter((content) => isRecord(content) && content.type === "cancel");
	expect(cancellations).toHaveLength(2);
	for (const id of [one.id, lastRequest.id])
		expect(cancellations).toContainEqual({ kind: "observablejs:import", protocol: 1, type: "cancel", id });
});
