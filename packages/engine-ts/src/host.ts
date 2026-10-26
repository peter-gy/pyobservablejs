/** A request for the host's network operation. Headers are name and value pairs. */
interface HostRequest {
	method: string;
	url: string;
	headers: [string, string][];
	body: Uint8Array | null;
}

/** A complete response. `headers` alternates names and values. */
export interface HostResponse {
	status: number;
	statusText: string;
	url: string;
	headers: string[];
	body: Uint8Array;
}

/** Operations the embedded V8 host installs before it evaluates the engine bundle. */
export interface EngineHost {
	send(header: string, buffers: readonly Uint8Array[]): void;
	/** Resolves with the next JSON request, or `null` after Python closes the engine. */
	receive(): Promise<string | null>;
	/** Fetch `data:` or HTTP(S) URLs under the engine's network policy. */
	fetch(request: HostRequest): Promise<HostResponse>;
	/** Resolve a `blob:` URL created in this isolate. */
	blob(url: string): Blob | null;
}

declare global {
	var __pyobservablejsHost: EngineHost | undefined;
}

/** Take the host operations off the global object before notebook code can run. */
export function claimHost(): EngineHost {
	const host = globalThis.__pyobservablejsHost;
	delete globalThis.__pyobservablejsHost;
	if (!host) throw new Error("The embedded engine host is unavailable");
	return host;
}
