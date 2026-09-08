import { describe, expect, test } from "vite-plus/test";
import { registerAttachments } from "../src/attachments";
import { createRuntime, createRuntimeCleanup } from "../src/environment";
import { createRuntimeInputs } from "../src/inputs";
import { type RuntimeValue, type Variables } from "../src/values";
import { waitFor } from "./testing";

function setup(variables: Variables = {}) {
	const registry = registerAttachments({});
	const runtime = createRuntime(
		document.createElement("div"),
		{
			attachments: {},
			baseUrl: "",
			variables,
		},
		registry,
	);
	const abort = new AbortController();
	const inputs = createRuntimeInputs({
		runtime,
		variables,
		viewNames: new Set(["value", "other"]),
		signal: abort.signal,
		onReplace() {},
		onError(_name, cause) {
			throw cause;
		},
	});
	return {
		runtime,
		inputs,
		dispose() {
			abort.abort();
			createRuntimeCleanup(runtime, registry)();
		},
	};
}

describe("native input variables", () => {
	test("keeps the newest async value for each connected control", async () => {
		const { inputs, dispose } = setup();
		let resolve!: (value: RuntimeValue) => void;
		const pending = new Promise<RuntimeValue>((done) => {
			resolve = done;
		});
		const first = Object.assign(new EventTarget(), { value: 0 });
		const other = Object.assign(new EventTarget(), { value: 0 });
		inputs.setView("value", first);
		inputs.setView("other", other);
		try {
			inputs.set({ value: pending });
			inputs.set({ value: 2, other: 3 });
			resolve(1);
			await waitFor(() => (first.value === 2 && other.value === 3 ? true : undefined));
			expect(first.value).toBe(2);
			expect(other.value).toBe(3);
		} finally {
			dispose();
		}
	});

	test("ignores async writes to detached controls", async () => {
		const { inputs, dispose } = setup();
		let resolve!: (value: RuntimeValue) => void;
		const pending = new Promise<RuntimeValue>((done) => {
			resolve = done;
		});
		const first = Object.assign(new EventTarget(), { value: 0 });
		const replacement = Object.assign(new EventTarget(), { value: 0 });
		inputs.setView("value", first);
		try {
			inputs.set({ value: pending });
			inputs.deleteView("value", first);
			inputs.setView("value", replacement);
			resolve(5);
			await waitFor(() => (replacement.value === 5 ? true : undefined));
			expect(first.value).toBe(0);
			expect(replacement.value).toBe(5);
		} finally {
			dispose();
		}
	});

	test("publishes rejected input promises through runtime evaluation", async () => {
		const { inputs, runtime, dispose } = setup();
		const view = Object.assign(new EventTarget(), { value: 0 });
		const failure = new Error("input unavailable");
		let rejected: string | undefined;
		runtime.main
			.variable({
				rejected(error) {
					if (error instanceof Error) rejected = error.message;
				},
			})
			.define("inputProbe", ["value"], (value: RuntimeValue) => value);
		inputs.setView("value", view);
		try {
			inputs.set({ value: Promise.reject(failure) });
			await waitFor(() => (rejected === "input unavailable" ? true : undefined));
			expect(rejected).toBe("input unavailable");
			expect(view.value).toBe(0);
		} finally {
			dispose();
		}
	});
});
