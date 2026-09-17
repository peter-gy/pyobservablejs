import { createDiagnostic, type Diagnostic, type MountedNotebook } from "@pyobservablejs/runtime";
import { isNumber, isString } from "@pyobservablejs/runtime/values";
import {
	isRecord,
	readSelector,
	readOptions,
	executeRead,
	describeResponse,
	type WireValue,
	type WireRead,
} from "@pyobservablejs/protocol";
import { type AnyWidgetModel, type WidgetModel, type WireDiagnostics } from "./model";

type NotebookAccess = Pick<MountedNotebook, "inspection" | "datasets" | "read" | "discover" | "diagnostics">;
export type ReadySnapshot = { readback: NonNullable<WidgetModel["_readback"]>; diagnostics: WireDiagnostics };
type ResponseBody =
	| {
			result:
				| WireRead
				| (ReadySnapshot & { ready: true })
				| NotebookAccess["inspection"]
				| Awaited<ReturnType<NotebookAccess["discover"]>>
				| ReturnType<typeof describeResponse>;
	  }
	| { error: Diagnostic; diagnostics?: WireDiagnostics };
type Request = {
	id: string;
	generation: string;
	params: Record<string, WireValue | undefined>;
};

const envelope = { kind: "observablejs:access", protocol: 1 } as const;

export function connectRequests(
	model: AnyWidgetModel,
	notebook: NotebookAccess,
	signal: AbortSignal,
	options?: {
		onError(cause: unknown, operation: string): void;
		ready(sequence: number, signal: AbortSignal): Promise<void>;
		checkpoint(): ReadySnapshot;
	},
): () => void {
	if (signal.aborted) return () => {};
	const generation = crypto.getRandomValues(new Uint32Array(4)).join("-");
	const pending = new Map<string, AbortController>();
	const publishDatasets = () => {
		if (signal.aborted) return;
		try {
			if (model.get("_inspection")?.generation !== generation) return;
			model.set("_datasets", { generation, values: notebook.datasets });
			model.save_changes();
		} catch (cause) {
			options?.onError(cause, "publish dataset metadata");
		}
	};
	const respond = (request: Request, body: ResponseBody, buffers: DataView[] = []) => {
		try {
			model.send(
				{ ...envelope, type: "response", id: request.id, generation: request.generation, ...body },
				undefined,
				buffers,
			);
		} catch (cause) {
			options?.onError(cause, "send response");
		}
	};
	const execute = async (request: Request, controller: AbortController) => {
		const phase: Diagnostic["phase"] = "transport";
		const operation = request.params.operation === "ready" ? "wait for view" : "read value";
		const active = () => !signal.aborted && !controller.signal.aborted && pending.get(request.id) === controller;
		try {
			if (request.params.operation === "ready") {
				if (!options?.ready) throw new Error("View readiness is unavailable");
				await options.ready(readSequence(request.params.sequence), AbortSignal.any([signal, controller.signal]));
				if (!active()) return;
				const snapshot = options.checkpoint();
				if (active()) respond(request, { result: { ready: true, ...snapshot } });
				return;
			}

			if (request.params.operation === "inspect") {
				respond(request, { result: notebook.inspection });
				return;
			}
			if (request.params.operation === "discover") {
				const deadline = request.params.deadline;
				const active = AbortSignal.any([signal, controller.signal]);
				const bounded = isNumber(deadline)
					? AbortSignal.any([active, AbortSignal.timeout(Math.max(1, Math.floor(deadline)))])
					: active;
				let catalog;
				try {
					catalog = await notebook.discover({ signal: bounded });
				} catch (cause) {
					if (!bounded.aborted || active.aborted) throw cause;
					catalog = { datasets: notebook.datasets, errors: notebook.diagnostics, pending: true };
				}
				if (!active.aborted) respond(request, { result: catalog });
				return;
			}
			const selector = readSelector(request.params.selector);
			if (request.params.operation === "describe") {
				const value = await notebook.read(selector, {
					...readOptions(request.params.options),
					format: "native",
					signal: AbortSignal.any([signal, controller.signal]),
				});
				respond(request, { result: describeResponse(value) });
				return;
			}

			const { result, buffers } = await executeRead(
				notebook,
				selector,
				readOptions(request.params.options),
				AbortSignal.any([signal, controller.signal]),
				"widget",
			);
			if (!active()) return;
			respond(request, { result }, buffers);
		} catch (cause) {
			if (active()) {
				const response: ResponseBody = {
					error: createDiagnostic(cause, {
						origin: "widget",
						phase,
						component: "packages/widget/src/requests.ts",
						operation,
					}),
				};
				if (request.params.operation === "ready" && options) response.diagnostics = options.checkpoint().diagnostics;
				if (active()) respond(request, response);
			}
		} finally {
			if (pending.get(request.id) === controller) pending.delete(request.id);
		}
	};
	const receive = (message: WireValue) => {
		if (!isRecord(message) || message.kind !== envelope.kind || message.protocol !== envelope.protocol) return;

		if (!isString(message.id) || !message.id || !isString(message.generation)) return;
		if (message.type === "cancel") {
			if (message.generation !== generation) return;
			const controller = pending.get(message.id);
			pending.delete(message.id);
			controller?.abort(new DOMException("Notebook request cancelled", "AbortError"));
			return;
		}
		// Custom messages reach every frontend sharing this widget model.
		if (message.type !== "request" || message.generation !== generation) return;
		const request: Request = {
			id: message.id,
			generation: message.generation,
			params: isRecord(message.params) ? message.params : {},
		};
		if (pending.has(request.id)) return;
		const controller = new AbortController();
		pending.set(request.id, controller);
		void execute(request, controller).catch((cause) => options?.onError(cause, "handle request"));
	};
	model.on("msg:custom", receive);
	signal.addEventListener(
		"abort",
		() => {
			try {
				model.off("msg:custom", receive);
				for (const controller of pending.values()) controller.abort(signal.reason);
				pending.clear();
				let changed = false;
				if (model.get("_inspection")?.generation === generation) {
					model.set("_inspection", {});
					changed = true;
				}
				if (model.get("_datasets")?.generation === generation) {
					model.set("_datasets", {});
					changed = true;
				}
				if (changed) model.save_changes();
			} catch (cause) {
				options?.onError(cause, "close request channel");
			}
		},
		{ once: true },
	);
	try {
		model.set("_inspection", { generation, value: notebook.inspection });
		model.set("_datasets", { generation, values: notebook.datasets });
		model.save_changes();
	} catch (cause) {
		if (!options) throw cause;
		options.onError(cause, "publish view metadata");
	}
	return publishDatasets;
}

function readSequence(value: WireValue | undefined): number {
	if (value === undefined) return 0;
	if (!isNumber(value) || !Number.isSafeInteger(value) || value < 0)
		throw new TypeError("sequence must be a non-negative integer");
	return value;
}
