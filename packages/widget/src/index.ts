import type { InitializeProps, RenderProps, ResolvedWidget } from "@anywidget/types";
import { readCellCompositionState } from "./composition-state";
import type { WidgetModel } from "./model";
import { installCellProjectionContext, readCellProjectionContext } from "./projection-context";
import type { ParentRenderer } from "./parent";

const CELL_MODEL_CHANGE_EVENTS = ["change:_notebook_widget", "change:_notebook_index"] as const;

export default function createWidget() {
	let parentRenderer: Promise<ParentRenderer> | undefined;

	const loadParentRenderer = (
		model: InitializeProps<WidgetModel>["model"],
		signal: AbortSignal,
	): Promise<ParentRenderer> => {
		// Cell models stay on this small dispatcher. Notebook Kit enters the model
		// graph only when the referenced parent model initializes or renders.
		parentRenderer ??= import("./parent").then((module) => {
			signal.throwIfAborted();
			return module.createParentRenderer(model, signal);
		});
		return parentRenderer;
	};

	return {
		initialize(props: InitializeProps<WidgetModel>) {
			if (props.model.get("role") !== "cell") void loadParentRenderer(props.model, props.signal).catch(() => {});
		},
		async render(props: RenderProps<WidgetModel>) {
			if (props.signal.aborted) return;
			if (props.model.get("role") === "cell") {
				renderCellProjection(props);
				return;
			}
			const renderer = await loadParentRenderer(props.model, props.signal);
			if (props.signal.aborted) return;
			renderer.render(props, readCellProjectionContext(props.el));
		},
	};
}

function renderCellProjection(props: RenderProps<WidgetModel>): void {
	let current = new AbortController();
	let version = 0;
	const rerender = () => {
		current.abort();
		current = new AbortController();
		const attempt = current;
		const signal = AbortSignal.any([props.signal, attempt.signal]);
		const renderVersion = ++version;
		const isCurrent = () => !signal.aborted && renderVersion === version;
		void renderCurrentCellProjection(props, signal).catch((error: unknown) => {
			if (!isCurrent()) return;
			attempt.abort();
			props.el.replaceChildren(createTopLevelError(error));
		});
	};
	for (const event of CELL_MODEL_CHANGE_EVENTS) props.model.on(event, rerender);
	props.signal.addEventListener(
		"abort",
		() => {
			for (const event of CELL_MODEL_CHANGE_EVENTS) props.model.off(event, rerender);
			current.abort();
		},
		{ once: true },
	);
	rerender();
}

async function renderCurrentCellProjection(props: RenderProps<WidgetModel>, signal: AbortSignal): Promise<void> {
	const composition = readCellCompositionState(props.model);
	installCellProjectionContext(props.el, props.model, composition.index, signal);
	const parent = await resolveParentWidget(props, composition.parentRef, signal);
	if (signal.aborted) return;
	await parent.render({ el: props.el, signal });
}

function resolveParentWidget(
	props: RenderProps<WidgetModel>,
	ref: string,
	signal: AbortSignal,
): Promise<ResolvedWidget> {
	const message = `Unable to resolve parent Notebook widget ${ref}`;
	if (signal.aborted) return Promise.reject(new Error(message));
	return abortable(
		Promise.resolve().then(() => props.host.getWidget(ref)),
		signal,
		message,
	);
}

function abortable<T>(lookup: Promise<T>, signal: AbortSignal, abortMessage: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(new Error(abortMessage));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		lookup.then(
			(value) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			},
		);
	});
}

function createTopLevelError(error: unknown): HTMLElement {
	const pre = document.createElement("pre");
	pre.className = "pyobservablejs-error";
	pre.setAttribute("role", "alert");
	pre.textContent = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	return pre;
}
