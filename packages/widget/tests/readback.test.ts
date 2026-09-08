import type { NotebookState } from "@pyobservablejs/runtime";
import { expect, test } from "vite-plus/test";
import { ReadbackPublisher } from "../src/readback";
import { createView } from "./testing";

test("shares the readback budget across cell values and restores available capacity", async () => {
	const model = createView();
	const controller = new AbortController();
	const publish = new ReadbackPublisher(model, controller.signal).start();
	const text = "x".repeat(100_000);
	const results: NotebookState["results"] = {
		0: { revision: 0, status: "success", values: { first: text }, errors: [] },
		1: { revision: 0, status: "success", values: { second: text, total: 42 }, errors: [] },
	};
	publish(snapshot(results));
	await Promise.resolve();
	expect(model.get("_readback")?.results[0]?.values.first).toBe(text);
	expect(model.get("_readback")?.results[1]?.values).toEqual({
		second: { __observablejs_type__: "summary", value: "String(100000)" },
		total: 42,
	});

	publish(snapshot({ ...results, 0: { revision: 1, status: "success", values: { first: "small" }, errors: [] } }, 1));
	await Promise.resolve();
	expect(model.get("_readback")?.results[1]?.values.second).toBe(text);
	controller.abort();
});

test("captures in-place changes when a cell reevaluates within an open revision", async () => {
	const model = createView();
	const controller = new AbortController();
	const publish = new ReadbackPublisher(model, controller.signal).start();
	const value = { amount: 1 };
	const ready = { revision: 0, status: "success" as const, values: { value }, errors: [] };
	const pending = { revision: 0, status: "pending" as const, values: {}, errors: [] };
	publish(snapshot({ 0: ready, 1: pending }));
	value.amount = 2;
	publish(snapshot({ 0: ready, 1: { ...pending, status: "success", values: { other: 3 } } }));
	await Promise.resolve();
	expect(model.get("_readback")?.results[0]?.values.value).toEqual({ amount: 1 });
	publish(snapshot({ 0: pending, 1: pending }));
	publish(snapshot({ 0: ready, 1: pending }));
	await Promise.resolve();
	expect(model.get("_readback")?.results[0]?.values.value).toEqual({ amount: 2 });
	controller.abort();
});

function snapshot(results: NotebookState["results"], revision = 0): NotebookState {
	const pending = Object.values(results).some((result) => result.status === "pending");
	return {
		inputRevision: revision,
		settledRevision: pending ? null : revision,
		pending,
		graph: null,
		results,
		errors: [],
	};
}

test("publishes one complete snapshot per synchronous burst and captures values before mutations", async () => {
	const model = createView();
	const controller = new AbortController();
	const publish = new ReadbackPublisher(model, controller.signal).start();
	const value = { amount: 1 };
	const pending = { revision: 0, status: "pending" as const, values: {}, errors: [] };
	publish(snapshot({ 0: pending }));
	publish(snapshot({ 0: { ...pending, status: "success", values: { value } } }));
	value.amount = 9;
	expect(model.savedReadbacks()).toHaveLength(0);
	await Promise.resolve();
	expect(model.savedReadbacks()).toHaveLength(1);
	expect(model.get("_readback")).toMatchObject({
		pending: false,
		results: { 0: { values: { value: { amount: 1 } } } },
	});
	controller.abort();
});

test("publishes asynchronous pending and settled states separately", async () => {
	const model = createView();
	const controller = new AbortController();
	const publish = new ReadbackPublisher(model, controller.signal).start();
	const pending = { revision: 0, status: "pending" as const, values: {}, errors: [] };
	publish(snapshot({ 0: pending }));
	await Promise.resolve();
	expect(model.get("_readback")?.pending).toBe(true);
	publish(snapshot({ 0: { ...pending, status: "success", values: { amount: 2 } } }));
	await Promise.resolve();
	expect(model.savedReadbacks().map((state) => state.pending)).toEqual([true, false]);
	controller.abort();
});

test("drops queued snapshots when the view closes", async () => {
	const model = createView();
	const controller = new AbortController();
	const publish = new ReadbackPublisher(model, controller.signal).start();
	publish(snapshot({ 0: { revision: 0, status: "success", values: { amount: 1 }, errors: [] } }));
	controller.abort();
	await Promise.resolve();
	expect(model.savedReadbacks()).toHaveLength(0);
});

test("restarts from queued revision offsets and ignores obsolete callbacks", async () => {
	const model = createView();
	const controller = new AbortController();
	const publisher = new ReadbackPublisher(model, controller.signal);
	const first = publisher.start();
	first(snapshot({ 0: { revision: 4, status: "success", values: { amount: 1 }, errors: [] } }, 4));
	const second = publisher.start();
	second(snapshot({ 0: { revision: 0, status: "success", values: { amount: 2 }, errors: [] } }));
	first(snapshot({ 0: { revision: 5, status: "success", values: { amount: 99 }, errors: [] } }, 5));
	await Promise.resolve();
	expect(model.savedReadbacks()).toHaveLength(1);
	expect(model.get("_readback")).toMatchObject({ input_revision: 5, results: { 0: { values: { amount: 2 } } } });
	controller.abort();
});

test("replaces queued results with the terminal failure", async () => {
	const model = createView();
	const controller = new AbortController();
	const publisher = new ReadbackPublisher(model, controller.signal);
	const publish = publisher.start();
	publish(snapshot({ 0: { revision: 0, status: "success", values: { amount: 1 }, errors: [] } }));
	publisher.fail(new Error("mount failed"));
	publish(snapshot({ 0: { revision: 0, status: "success", values: { amount: 99 }, errors: [] } }));
	await Promise.resolve();
	expect(model.savedReadbacks()).toHaveLength(1);
	expect(model.get("_readback")).toMatchObject({ pending: false, results: {}, errors: [{ message: "mount failed" }] });
	controller.abort();
});
