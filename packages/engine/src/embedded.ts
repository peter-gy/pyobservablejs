import { host } from "./prelude";

// Notebook Kit reads `document` when its modules evaluate. Dynamic imports fix
// that order regardless of how the bundler groups modules into chunks.
await import("./dom");
const [{ evaluateNotebook }, { isRecord }, { createService }] = await Promise.all([
	import("@pyobservablejs/runtime/headless"),
	import("@pyobservablejs/protocol"),
	import("./service"),
]);

const service = createService((message, buffers = []) => {
	host.send(
		JSON.stringify(message),
		buffers.map((buffer) => new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)),
	);
}, evaluateNotebook);

/** Dispatch requests in arrival order until Python closes the engine. */
const served = new Promise<void>((resolve, reject) => {
	// Each receive schedules the next one, so no promise chain outlives a request.
	const next = () => {
		host.receive().then((request) => {
			if (request === null) return resolve();
			try {
				const message: ReturnType<typeof JSON.parse> = JSON.parse(request);
				if (!isRecord(message)) throw new TypeError("Engine request must be an object");
				service.receive(message);
			} catch (cause) {
				return reject(cause);
			}
			next();
		}, reject);
	};
	next();
});

host.send(JSON.stringify({ type: "ready", protocol: 1 }), []);
try {
	await served;
} finally {
	service.close();
}
