import { isString } from "@pyobservablejs/runtime/values";
import type { EngineHost, HostResponse } from "./host";

type HeaderPairs = Iterable<readonly [string, string]>;
type HeaderInput = HeaderPairs | Readonly<Record<string, string>>;
type BodyInput = string | ArrayBuffer | ArrayBufferView | Blob | URLSearchParams | ReadableStream<Uint8Array>;
type StoredBody = Uint8Array | ReadableStream<Uint8Array> | null;

const encoder = new TextEncoder();

function isHeaderPairs(input: HeaderInput): input is HeaderPairs {
	return Symbol.iterator in input;
}

function bytesOf(value: ArrayBuffer | ArrayBufferView): Uint8Array {
	return ArrayBuffer.isView(value)
		? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
		: new Uint8Array(value);
}

/** Header names fold to lower case. Repeated values join with a comma. */
export class EngineHeaders {
	readonly #values = new Map<string, string>();

	constructor(init: HeaderInput | null = null) {
		if (init === null) return;
		for (const [name, value] of isHeaderPairs(init) ? init : Object.entries(init)) this.append(name, value);
	}

	append(name: string, value: string): void {
		const key = name.toLowerCase();
		const current = this.#values.get(key);
		this.#values.set(key, current === undefined ? value.trim() : `${current}, ${value.trim()}`);
	}

	delete(name: string): void {
		this.#values.delete(name.toLowerCase());
	}

	get(name: string): string | null {
		return this.#values.get(name.toLowerCase()) ?? null;
	}

	has(name: string): boolean {
		return this.#values.has(name.toLowerCase());
	}

	set(name: string, value: string): void {
		this.#values.set(name.toLowerCase(), value.trim());
	}

	forEach(callback: (value: string, name: string, headers: EngineHeaders) => void): void {
		for (const [name, value] of this) callback(value, name, this);
	}

	*entries(): IterableIterator<[string, string]> {
		yield* [...this.#values].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	}

	*keys(): IterableIterator<string> {
		for (const [name] of this.entries()) yield name;
	}

	*values(): IterableIterator<string> {
		for (const [, value] of this.entries()) yield value;
	}

	[Symbol.iterator](): IterableIterator<[string, string]> {
		return this.entries();
	}
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	const reader = stream.getReader();
	const read = (): Promise<void> =>
		reader.read().then((chunk) => {
			if (chunk.done) return;
			chunks.push(chunk.value);
			return read();
		});
	await read();
	const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

/** Normalize a body and set the content type its representation implies. */
async function encodeBody(body: BodyInput, headers: EngineHeaders): Promise<Uint8Array> {
	const implied = (type: string) => {
		if (type && !headers.has("content-type")) headers.set("content-type", type);
	};
	if (isString(body)) {
		implied("text/plain;charset=UTF-8");
		return encoder.encode(body);
	}
	if (body instanceof URLSearchParams) {
		implied("application/x-www-form-urlencoded;charset=UTF-8");
		return encoder.encode(body.toString());
	}
	if (body instanceof Blob) {
		implied(body.type);
		return new Uint8Array(await body.arrayBuffer());
	}
	if (body instanceof ReadableStream) return collect(body);
	return bytesOf(body).slice();
}

class Body {
	readonly headers: EngineHeaders;
	#source: StoredBody;
	#pending: Promise<Uint8Array> | null;
	#used = false;

	constructor(body: BodyInput | null, headers: EngineHeaders) {
		this.headers = headers;
		if (body === null || body instanceof ReadableStream) {
			this.#source = body;
			this.#pending = null;
		} else if (isString(body) || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
			this.#source = isString(body) ? encoder.encode(body) : bytesOf(body);
			this.#pending = null;
			if (isString(body) && !headers.has("content-type")) headers.set("content-type", "text/plain;charset=UTF-8");
		} else {
			this.#source = null;
			this.#pending = encodeBody(body, headers);
		}
	}

	get bodyUsed(): boolean {
		return this.#used;
	}

	get body(): ReadableStream<Uint8Array> | null {
		if (this.#pending !== null) {
			const pending = this.#pending;
			this.#pending = null;
			this.#source = new ReadableStream({
				async start(controller) {
					controller.enqueue(await pending);
					controller.close();
				},
			});
		}
		if (this.#source === null || this.#source instanceof ReadableStream) return this.#source;
		const bytes = this.#source;
		this.#source = new ReadableStream({
			start(controller) {
				if (bytes.byteLength) controller.enqueue(bytes);
				controller.close();
			},
		});
		return this.#source;
	}

	/** Read the whole body once. */
	async bytes(): Promise<Uint8Array> {
		if (this.#used) throw new TypeError("Body has already been consumed");
		this.#used = true;
		if (this.#pending !== null) return this.#pending;
		if (this.#source === null) return new Uint8Array();
		return this.#source instanceof ReadableStream ? collect(this.#source) : this.#source;
	}

	async arrayBuffer(): Promise<ArrayBuffer> {
		return (await this.bytes()).slice().buffer;
	}

	async text(): Promise<string> {
		return new TextDecoder().decode(await this.bytes());
	}

	async json(): Promise<ReturnType<typeof JSON.parse>> {
		return JSON.parse(await this.text());
	}

	async blob(): Promise<Blob> {
		return new Blob([(await this.bytes()).slice()], { type: this.headers.get("content-type") ?? "" });
	}

	/** Detach a copy of the unread body for `clone()`. */
	protected cloneBody(): StoredBody {
		if (this.#used) throw new TypeError("Body has already been consumed");
		if (this.#pending !== null) {
			void this.body;
		}
		if (this.#source instanceof ReadableStream) {
			const [left, right] = this.#source.tee();
			this.#source = left;
			return right;
		}
		return this.#source;
	}
}

interface RequestOptions {
	method?: string;
	headers?: HeaderInput;
	body?: BodyInput | null;
	signal?: AbortSignal | null;
}

export class EngineRequest extends Body {
	readonly url: string;
	readonly method: string;
	readonly signal: AbortSignal;

	constructor(input: string | URL | EngineRequest, init: RequestOptions = {}) {
		const base = input instanceof EngineRequest ? input : null;
		super(
			init.body !== undefined ? init.body : (base?.cloneBody() ?? null),
			new EngineHeaders(init.headers ?? base?.headers ?? null),
		);
		const target = input instanceof EngineRequest ? input.url : input instanceof URL ? input.href : input;
		this.url = new URL(target, globalThis.location?.href).href;
		this.method = (init.method ?? base?.method ?? "GET").toUpperCase();
		this.signal = init.signal ?? base?.signal ?? new AbortController().signal;
	}

	clone(): EngineRequest {
		return new EngineRequest(this, { body: this.cloneBody() });
	}
}

interface ResponseOptions {
	status?: number;
	statusText?: string;
	headers?: HeaderInput;
}

export class EngineResponse extends Body {
	readonly status: number;
	readonly statusText: string;
	type: "basic" | "error" = "basic";
	url = "";
	redirected = false;

	constructor(body: BodyInput | null = null, init: ResponseOptions = {}) {
		super(body, new EngineHeaders(init.headers ?? null));
		this.status = init.status ?? 200;
		this.statusText = init.statusText ?? "";
	}

	get ok(): boolean {
		return this.status >= 200 && this.status < 300;
	}

	clone(): EngineResponse {
		const response = new EngineResponse(this.cloneBody(), this);
		response.url = this.url;
		response.redirected = this.redirected;
		return response;
	}

	static json(data: ReturnType<typeof JSON.parse>, init: ResponseOptions = {}): EngineResponse {
		const headers = new EngineHeaders(init.headers ?? null);
		if (!headers.has("content-type")) headers.set("content-type", "application/json");
		return new EngineResponse(JSON.stringify(data), { ...init, headers });
	}

	static error(): EngineResponse {
		const response = new EngineResponse(null, { status: 0 });
		response.type = "error";
		return response;
	}
}

function hostResponse(result: HostResponse, requested: string): EngineResponse {
	const headers: [string, string][] = [];
	for (let index = 0; index + 1 < result.headers.length; index += 2)
		headers.push([result.headers[index]!, result.headers[index + 1]!]);
	const response = new EngineResponse(result.body, {
		status: result.status,
		statusText: result.statusText,
		headers,
	});
	response.url = result.url;
	response.redirected = result.url !== requested;
	return response;
}

/** Bind `fetch` to the host's network operation and its policy. */
export function createFetch(host: Pick<EngineHost, "fetch" | "blob">) {
	return async function fetch(input: string | URL | EngineRequest, init?: RequestOptions): Promise<EngineResponse> {
		const request = new EngineRequest(input, init);
		const { signal } = request;
		signal.throwIfAborted();
		if (request.url.startsWith("blob:")) {
			const blob = host.blob(request.url);
			if (blob === null) throw new TypeError(`Blob URL is unavailable: ${request.url}`);
			const response = new EngineResponse(blob, { headers: [["content-type", blob.type]] });
			response.url = request.url;
			return response;
		}
		const body = request.body === null ? null : await request.bytes();
		const pending = host.fetch({ method: request.method, url: request.url, headers: [...request.headers], body });
		const result = await new Promise<HostResponse>((resolve, reject) => {
			const abort = () => reject(signal.reason);
			signal.addEventListener("abort", abort, { once: true });
			pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
		});
		return hostResponse(result, request.url);
	};
}
