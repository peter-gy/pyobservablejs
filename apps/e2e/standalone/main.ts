import { isNumber, isObjectValue, type RuntimeValue } from "@pyobservablejs/runtime/values";
import { mountNotebook, type NotebookSpec, type NotebookState } from "@pyobservablejs/runtime";

const app = document.querySelector<HTMLElement>("#app")!;

function region(name: string): HTMLElement {
	const element = document.createElement("section");
	element.setAttribute("aria-label", name);
	app.appendChild(element);
	return element;
}

function status(name: string): HTMLOutputElement {
	const element = document.createElement("output");
	element.setAttribute("aria-label", name);
	app.appendChild(element);
	return element;
}

function button(label: string, action: () => void): void {
	const element = document.createElement("button");
	element.textContent = label;
	element.addEventListener("click", action);
	app.appendChild(element);
}

function nativeValues(): void {
	const identity = status("Native identity");
	const graph = status("Selection graph");
	const transform = (value: number) => value * 3;
	const items = new Map([["count", 7]]);
	const moment = new Date("2026-01-02T00:00:00Z");
	const node = document.createElement("strong");
	node.textContent = "Native DOM element";
	const source = `<notebook>
  <script id="1" type="module">const subtotal = transform(items.get("count"));</script>
  <script id="2" type="module">
    const received = {transform, items, moment, node, missing};
    display(html\`<output aria-label="Native result">\${subtotal} on \${moment.toISOString().slice(0, 10)}, missing=\${missing === undefined}</output>\`);
    display(node);
  </script>
  <script id="3" type="module">throw new Error("Unselected cell must not evaluate");</script>
</notebook>`;
	mountNotebook(region("Native notebook"), source, {
		variables: { transform, items, moment, node, missing: undefined },
		selection: [1],
		onState(state) {
			if (state.pending) return;
			const received = state.results[1]?.values.received;
			identity.textContent =
				isObjectValue(received) &&
				"transform" in received &&
				received.transform === transform &&
				"items" in received &&
				"moment" in received &&
				"node" in received &&
				"missing" in received &&
				received.items === items &&
				received.moment === moment &&
				received.node === node &&
				Object.prototype.hasOwnProperty.call(received, "missing") &&
				received.missing === undefined
					? "All native identities preserved"
					: "Native identity mismatch";
			graph.textContent = `Graph cells: ${state.graph?.cells.map((cell) => cell.id).join(", ")}. Result cells: ${Object.keys(state.results).join(", ")}.`;
		},
	});
}

function inputs(): void {
	const events = status("Input events");
	const stateStatus = status("Input state");
	let eventCount = 0;
	events.textContent = "0 interactions";
	const notebook = mountNotebook(
		region("Input notebook"),
		{
			cells: [
				{
					id: 1,
					mode: "ojs",
					value:
						'viewof amount = Object.assign(document.createElement("input"), {type: "range", min: "0", max: "10", value: "2", ariaLabel: "Amount"})',
				},
				{ id: 2, value: "const multiplier = 3;" },
				{
					id: 3,
					value: 'const total = amount * multiplier; display(html`<output aria-label="Total">${total}</output>`);',
				},
			],
		},
		{
			onInput(name, value) {
				if (isNumber(value)) events.textContent = `${++eventCount} interactions: ${name}=${value}`;
			},
			onState(state) {
				const total = state.results[2]?.values.total;
				stateStatus.textContent = !state.pending && isNumber(total) ? `Settled total=${total}` : "Evaluating";
			},
		},
	);
	button("Inject multiplier", () => notebook.updateVariables({ multiplier: 5 }));
	button("Restore authored variables", () => notebook.replaceVariables({}));
	button("Set input programmatically", () => notebook.setInputs({ amount: 4 }));
}

function nativeInputs(): void {
	const names = ["day", "upload", "uploads", "action", "enabled"] as const;
	const events = new Map(names.map((name) => [name, status(`${name} event`)]));
	const values = names.map((name) => status(`${name} value`));
	for (const output of events.values()) output.textContent = "No events";
	const notebook = mountNotebook(
		region("Native input notebook"),
		{
			cells: [
				{
					id: 1,
					mode: "ojs",
					value:
						'viewof day = Object.assign(document.createElement("input"), {type: "date", value: "2025-01-02", ariaLabel: "Day"})',
				},
				{
					id: 2,
					mode: "ojs",
					value: 'viewof upload = Object.assign(document.createElement("input"), {type: "file", ariaLabel: "Upload"})',
				},
				{
					id: 3,
					mode: "ojs",
					value:
						'viewof uploads = Object.assign(document.createElement("input"), {type: "file", multiple: true, ariaLabel: "Uploads"})',
				},
				{
					id: 4,
					mode: "ojs",
					value:
						'viewof action = {const button = Object.assign(document.createElement("button"), {type: "button", value: "0", textContent: "Count click"}); button.onclick = () => button.value = String(Number(button.value) + 1); return button;}',
				},
				{
					id: 5,
					mode: "ojs",
					value:
						'viewof enabled = Object.assign(document.createElement("input"), {type: "checkbox", ariaLabel: "Enabled"})',
				},
			],
		},
		{
			onInput(name, value) {
				for (const [key, output] of events) {
					if (key === name) output.textContent = describeInput(value);
				}
			},
			onState(state) {
				for (const [index, name] of names.entries()) {
					values[index]!.textContent = describeInput(state.results[index]?.values[name]);
				}
			},
		},
	);
	button("Set day", () => notebook.setInputs({ day: new Date("2025-05-06T12:00:00Z") }));
	button("Clear day", () => notebook.setInputs({ day: null }));
	button("Inject file", () => notebook.updateVariables({ upload: new File(["native"], "injected.txt") }));
}

function describeInput(value: RuntimeValue): string {
	if (value instanceof Date) return `Date:${value.toISOString().slice(0, 10)}`;
	if (value instanceof File) return `File:${value.name}:${value.size}`;
	if (value instanceof FileList) return `FileList:${Array.from(value, (file) => file.name).join(",")}`;
	if (isObjectValue(value)) return "Unexpected object";
	return String(value);
}

function shadowStyles(): void {
	const host = region("Shadow notebook host");
	const shadow = host.attachShadow({ mode: "open" });
	const target = document.createElement("div");
	shadow.appendChild(target);
	mountNotebook(
		target,
		{
			theme: "midnight",
			cells: [
				{ id: 1, mode: "md", value: "# Inside the shadow root\n\nStyled notebook content." },
				{ id: 2, value: "const answer = 42;", pinned: true },
			],
		},
		{ showSource: true },
	);
}

function lifecycle(): void {
	const started = status("Async evaluation");
	const cancelled = status("Cancelled publications");
	const siblingStatus = status("Sibling state");
	const cancellation = new AbortController();
	const target = region("Cancelled notebook");
	let release!: (value: string) => void;
	const gate = new Promise<string>((resolve) => {
		release = resolve;
	});
	let publications = 0;
	let frozenPublications = 0;
	mountNotebook(
		target,
		{
			cells: [{ id: 1, value: "started(); const result = await wait(); display(result);" }],
		},
		{
			signal: cancellation.signal,
			variables: {
				wait: () => gate,
				started: () => {
					started.textContent = "Started";
				},
			},
			onState() {
				publications += 1;
				cancelled.textContent = String(publications - frozenPublications);
			},
		},
	);
	const siblingSpec: NotebookSpec = {
		cells: [{ id: 1, value: 'display(html`<output aria-label="Sibling value">${value}</output>`);' }],
	};
	const sibling = mountNotebook(region("Sibling notebook"), siblingSpec, {
		variables: { value: "Independent" },
		onState(state: NotebookState) {
			siblingStatus.textContent = state.pending ? "Evaluating" : "Settled";
		},
	});
	button("Cancel and remount", () => {
		cancellation.abort();
		frozenPublications = publications;
		cancelled.textContent = "0";
		mountNotebook(target, { cells: [{ id: 2, mode: "md", value: "Replacement mount" }] });
	});
	button("Resolve cancelled work", () => {
		release("Stale output");
		sibling.updateVariables({ value: "Still independent" });
	});
	button("Dispose sibling", () => {
		sibling.dispose();
		sibling.dispose();
	});
}

function responsiveWidth(): void {
	const target = region("Responsive notebook");
	target.style.width = "240.5px";
	const width = status("Notebook width");
	const notebook = mountNotebook(
		target,
		{ cells: [{ id: 1, value: "const measured = width;", hidden: true }] },
		{
			onState(state) {
				const measured = state.results[0]?.values.measured;
				if (!state.pending && isNumber(measured)) width.textContent = String(measured);
			},
		},
	);
	button("Resize notebook", () => {
		target.style.width = "180.25px";
	});
	button("Dispose notebook", () => {
		notebook.dispose();
	});
}

switch (new URLSearchParams(location.search).get("scenario")) {
	case "width":
		responsiveWidth();
		break;
	case "inputs":
		inputs();
		break;
	case "native-inputs":
		nativeInputs();
		break;
	case "shadow":
		shadowStyles();
		break;
	case "lifecycle":
		lifecycle();
		break;
	default:
		nativeValues();
}
