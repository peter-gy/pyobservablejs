import { createFetch, EngineHeaders, EngineRequest, EngineResponse } from "./fetch";
import { claimHost } from "./host";

/** Host operations, claimed before any other engine module evaluates. */
export const host = claimHost();

Object.assign(globalThis, {
	fetch: createFetch(host),
	Headers: EngineHeaders,
	Request: EngineRequest,
	Response: EngineResponse,
	// Happy DOM binds Node's immediate timers when its window module loads. The
	// embedded host schedules them as zero-delay web timers.
	setImmediate: <Args extends unknown[]>(callback: (...args: Args) => void, ...args: Args) =>
		setTimeout(callback, 0, ...args),
	clearImmediate: (id: number) => clearTimeout(id),
});
