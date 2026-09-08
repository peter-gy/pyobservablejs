import { afterEach, expect, test, vi } from "vite-plus/test";
import { mountNotebook, type MountedNotebook } from "../src";
import { waitFor } from "./testing";

const mounts: MountedNotebook[] = [];
afterEach(() => {
	for (const mount of mounts.splice(0)) mount.dispose();
});

function mountControl(control: HTMLElement & { value: string | number }) {
	const onInput = vi.fn();
	const mount = mountNotebook(
		document.createElement("div"),
		{ cells: [{ id: 1, mode: "ojs", value: "viewof choice = control" }] },
		{ variables: { control }, onInput },
	);
	mounts.push(mount);
	return { mount, onInput };
}

test("overrides values rejected by a control handler and reconnects representable writes", async () => {
	const control = Object.assign(document.createElement("form"), { value: 1 });
	const coerce = () => {
		control.value = 1;
	};
	control.addEventListener("input", coerce);
	const { mount, onInput } = mountControl(control);
	await waitFor(() => (mount.state.results[0]?.values.choice === 1 ? true : undefined));
	mount.updateVariables({ choice: 2 });
	await waitFor(() => (mount.state.results[0]?.values.choice === 2 && !mount.state.pending ? true : undefined));
	expect(control.value).toBe(1);
	expect(onInput).not.toHaveBeenCalled();
	mount.updateVariables({ choice: 1 });
	await waitFor(() => (mount.state.results[0]?.values.choice === 1 && !mount.state.pending ? true : undefined));
	control.removeEventListener("input", coerce);
	control.value = 3;
	control.dispatchEvent(new Event("input", { bubbles: true }));
	await waitFor(() => (mount.state.results[0]?.values.choice === 3 && !mount.state.pending ? true : undefined));
	expect(onInput).toHaveBeenCalledExactlyOnceWith("choice", 3);
});

test("publishes native dates and clears date controls through the mount API", async () => {
	const control = document.createElement("input");
	control.type = "date";
	control.value = "2025-01-02";
	const { mount, onInput } = mountControl(control);
	await waitFor(() => (mount.state.results[0]?.status === "success" ? true : undefined));
	control.value = "2025-03-04";
	control.dispatchEvent(new Event("input", { bubbles: true }));
	expect(onInput).toHaveBeenLastCalledWith("choice", new Date("2025-03-04"));
	control.value = "";
	control.dispatchEvent(new Event("input", { bubbles: true }));
	expect(onInput).toHaveBeenLastCalledWith("choice", null);
	mount.setInputs({ choice: new Date("2025-05-06T12:00:00Z") });
	await waitFor(() => {
		const value = mount.state.results[0]?.values.choice;
		return value && Date.prototype.toISOString.call(value) === "2025-05-06T00:00:00.000Z" && !mount.state.pending
			? true
			: undefined;
	});
	expect(mount.state.results[0]?.values.choice).toEqual(new Date("2025-05-06"));
	mount.setInputs({ choice: null });
	await waitFor(() => (mount.state.results[0]?.values.choice === null && !mount.state.pending ? true : undefined));
	expect(control.value).toBe("");
	expect(onInput).toHaveBeenCalledTimes(2);
	control.dispatchEvent(new Event("input", { bubbles: true }));
	expect(onInput).toHaveBeenCalledTimes(2);
});

test.each([false, true])("publishes native file selections with multiple=%s", async (multiple) => {
	const control = document.createElement("input");
	control.type = "file";
	control.multiple = multiple;
	const file = new File(["sample"], "sample.txt", { type: "text/plain" });
	const files = multiple ? control.files : Object.assign([file], { item: (index: number) => [file][index] ?? null });
	if (!files) throw new Error("File input did not provide a FileList");
	// JSDOM has no DataTransfer upload setter, so supply a selection through its DOM getter.
	if (!multiple) vi.spyOn(control, "files", "get").mockReturnValue(files);
	const { mount, onInput } = mountControl(control);
	await waitFor(() => (mount.state.results[0]?.status === "success" ? true : undefined));
	control.dispatchEvent(new Event("change", { bubbles: true }));
	expect(onInput).toHaveBeenCalledExactlyOnceWith("choice", multiple ? files : file);
	await waitFor(() => (mount.state.results[0]?.values.choice === (multiple ? files : file) ? true : undefined));
	expect(mount.state.results[0]?.values.choice).toBe(multiple ? files : file);
	expect(() => mount.setInputs({ choice: file })).not.toThrow();
	expect(control.files).toBe(files);
	expect(onInput).toHaveBeenCalledTimes(1);
	const injected = new File(["injected"], "injected.txt");
	mount.updateVariables({ choice: injected });
	await waitFor(() => (mount.state.results[0]?.values.choice === injected && !mount.state.pending ? true : undefined));
	expect(control.files).toBe(files);
});

test("settles the first file selection after an initially empty file input", async () => {
	const control = document.createElement("input");
	control.type = "file";
	let files = control.files;
	let reads = 0;
	vi.spyOn(control, "files", "get").mockImplementation(() => {
		reads += 1;
		return files;
	});
	const { mount, onInput } = mountControl(control);
	await waitFor(() => (reads > 0 && control.parentElement ? true : undefined));
	const file = new File(["first"], "first.txt");
	files = Object.assign([file], { item: (index: number) => [file][index] ?? null });
	control.dispatchEvent(new Event("input", { bubbles: true }));
	control.dispatchEvent(new Event("change", { bubbles: true }));
	await waitFor(() => (mount.state.results[0]?.values.choice === file && !mount.state.pending ? true : undefined));
	expect(onInput).toHaveBeenCalledExactlyOnceWith("choice", file);
});

test.each(["button", "submit", "checkbox"] as const)("publishes click-driven %s inputs once", async (type) => {
	const control = document.createElement("input");
	control.type = type;
	control.value = "before";
	const { mount, onInput } = mountControl(control);
	await waitFor(() => (mount.state.results[0]?.status === "success" ? true : undefined));
	control.value = "after";
	control.checked = true;
	control.dispatchEvent(new Event("click", { bubbles: true }));
	expect(onInput).toHaveBeenCalledExactlyOnceWith("choice", type === "checkbox" ? true : "after");
	control.dispatchEvent(new Event("input", { bubbles: true }));
	control.dispatchEvent(new Event("change", { bubbles: true }));
	expect(onInput).toHaveBeenCalledTimes(1);
	mount.setInputs({ choice: type === "checkbox" ? false : "programmatic" });
	await waitFor(() =>
		mount.state.results[0]?.values.choice === (type === "checkbox" ? false : "programmatic") && !mount.state.pending
			? true
			: undefined,
	);
	expect(onInput).toHaveBeenCalledTimes(1);
});

test("publishes native button element clicks and removes listeners on disposal", async () => {
	const control = document.createElement("button");
	control.type = "button";
	control.value = "before";
	const { mount, onInput } = mountControl(control);
	await waitFor(() => (mount.state.results[0]?.status === "success" ? true : undefined));
	control.value = "after";
	control.dispatchEvent(new Event("click", { bubbles: true }));
	expect(onInput).toHaveBeenCalledExactlyOnceWith("choice", "after");
	mount.dispose();
	control.value = "disposed";
	control.dispatchEvent(new Event("click", { bubbles: true }));
	expect(onInput).toHaveBeenCalledTimes(1);
});
