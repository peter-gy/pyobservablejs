// Install the web platform globals that notebook code and the engine bundle use,
// expose the host operations, and remove deno_core's bootstrap handles. The
// engine bundle installs fetch over these operations.
(() => {
	const core = Deno.core;
	const ops = core.ops;
	const load = (name) => core.loadExtScript(`ext:deno_web/${name}.js`);
	const webidl = core.loadExtScript("ext:deno_webidl/00_webidl.js");
	// Lazy scripts read `__bootstrap` when they first load. Load every script now
	// so later internal lookups resolve from the cache after it is removed.
	for (const name of ["00_infra", "01_mimesniff", "01_urlpattern", "04_global_interfaces", "12_location"]) load(name);
	const url = load("00_url");
	const { Console } = load("01_console");
	const { DOMException } = load("01_dom_exception");
	const event = load("02_event");
	const { structuredClone } = load("02_structured_clone");
	const timers = load("02_timers");
	const { AbortController, AbortSignal } = load("03_abort_signal");
	const { Window } = load("04_global_interfaces");
	const { atob, btoa } = load("05_base64");
	const streams = load("06_streams");
	const encoding = load("08_text_encoding");
	const file = load("09_file");
	const { FileReader } = load("10_filereader");
	const { MessageChannel, MessagePort } = load("13_message_port");
	const { CompressionStream, DecompressionStream } = load("14_compression");
	const performance = load("15_performance");
	const { ImageData } = load("16_image_data");
	const geometry = load("17_geometry");
	load("01_broadcast_channel");
	load("18_css_stylesheet");

	const randomValues = (array) => {
		if (
			!ArrayBuffer.isView(array) ||
			array instanceof DataView ||
			array instanceof Float32Array ||
			array instanceof Float64Array
		)
			throw new TypeError("getRandomValues requires an integer typed array");
		if (array.byteLength > 65536) throw new RangeError("getRandomValues is limited to 65536 bytes");
		ops.op_engine_random(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
		return array;
	};
	const crypto = Object.freeze({
		getRandomValues: randomValues,
		randomUUID() {
			const bytes = randomValues(new Uint8Array(16));
			bytes[6] = (bytes[6] & 0x0f) | 0x40;
			bytes[8] = (bytes[8] & 0x3f) | 0x80;
			const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
			return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
		},
	});

	const writable = (value) => ({ value, writable: true, enumerable: false, configurable: true });
	Object.defineProperties(globalThis, {
		self: writable(globalThis),
		console: writable(new Console((message) => ops.op_engine_log(message.replace(/\n$/, "")))),
		crypto: writable(crypto),
		URL: writable(url.URL),
		URLSearchParams: writable(url.URLSearchParams),
		DOMException: writable(DOMException),
		Event: writable(event.Event),
		EventTarget: writable(event.EventTarget),
		CustomEvent: writable(event.CustomEvent),
		ErrorEvent: writable(event.ErrorEvent),
		MessageEvent: writable(event.MessageEvent),
		ProgressEvent: writable(event.ProgressEvent),
		PromiseRejectionEvent: writable(event.PromiseRejectionEvent),
		CloseEvent: writable(event.CloseEvent),
		reportError: writable(event.reportError),
		structuredClone: writable(structuredClone),
		setTimeout: writable(timers.setTimeout),
		clearTimeout: writable(timers.clearTimeout),
		setInterval: writable(timers.setInterval),
		clearInterval: writable(timers.clearInterval),
		AbortController: writable(AbortController),
		AbortSignal: writable(AbortSignal),
		atob: writable(atob),
		btoa: writable(btoa),
		ReadableStream: writable(streams.ReadableStream),
		ReadableStreamDefaultReader: writable(streams.ReadableStreamDefaultReader),
		ReadableByteStreamController: writable(streams.ReadableByteStreamController),
		WritableStream: writable(streams.WritableStream),
		TransformStream: writable(streams.TransformStream),
		ByteLengthQueuingStrategy: writable(streams.ByteLengthQueuingStrategy),
		CountQueuingStrategy: writable(streams.CountQueuingStrategy),
		TextEncoder: writable(encoding.TextEncoder),
		TextDecoder: writable(encoding.TextDecoder),
		TextEncoderStream: writable(encoding.TextEncoderStream),
		TextDecoderStream: writable(encoding.TextDecoderStream),
		Blob: writable(file.Blob),
		File: writable(file.File),
		FileReader: writable(FileReader),
		MessageChannel: writable(MessageChannel),
		MessagePort: writable(MessagePort),
		CompressionStream: writable(CompressionStream),
		DecompressionStream: writable(DecompressionStream),
		performance: writable(performance.performance),
		Performance: writable(performance.Performance),
		PerformanceEntry: writable(performance.PerformanceEntry),
		PerformanceMark: writable(performance.PerformanceMark),
		PerformanceMeasure: writable(performance.PerformanceMeasure),
		PerformanceObserver: writable(performance.PerformanceObserver),
		PerformanceObserverEntryList: writable(performance.PerformanceObserverEntryList),
		ImageData: writable(ImageData),
		DOMMatrix: writable(geometry.DOMMatrix),
		DOMMatrixReadOnly: writable(geometry.DOMMatrixReadOnly),
		DOMPoint: writable(geometry.DOMPoint),
		DOMPointReadOnly: writable(geometry.DOMPointReadOnly),
		DOMQuad: writable(geometry.DOMQuad),
		DOMRect: writable(geometry.DOMRect),
		DOMRectReadOnly: writable(geometry.DOMRectReadOnly),
	});
	performance.setTimeOrigin();

	// The global object dispatches `error` and `unhandledrejection` like a window.
	Object.setPrototypeOf(globalThis, Window.prototype);
	Object.defineProperty(globalThis, webidl.brand, { value: webidl.brand, enumerable: false, configurable: true });
	event.setEventTargetData(globalThis);
	event.saveGlobalThisReference(globalThis);
	core.setReportExceptionCallback(event.reportException);
	core.setUnhandledPromiseRejectionHandler((promise, reason) => {
		const rejection = new event.PromiseRejectionEvent("unhandledrejection", { cancelable: true, promise, reason });
		globalThis.dispatchEvent(rejection);
		return rejection.defaultPrevented;
	});
	core.setHandledPromiseRejectionHandler((promise, reason) => {
		globalThis.dispatchEvent(new event.PromiseRejectionEvent("rejectionhandled", { promise, reason }));
	});

	Object.defineProperty(globalThis, "__pyobservablejsHost", {
		configurable: true,
		value: Object.freeze({
			send: (header, buffers) => ops.op_engine_send(header, buffers),
			receive: () => ops.op_engine_receive(),
			fetch: (request) => ops.op_engine_fetch(request),
			blob: (url) => file.blobFromObjectUrl(url),
		}),
	});
	delete globalThis.__bootstrap;
	delete globalThis.Deno;
})();
