import { isRecord } from "./read";
import { isNumber } from "@pyobservablejs/runtime/values";
import type { WireValue } from "./values";

const maximum = 64 * 1024 * 1024;
export function encodeFrame<Message extends object>(
	message: Message,
	buffers: readonly DataView[] = [],
): Uint8Array<ArrayBuffer> {
	const header = new TextEncoder().encode(
		JSON.stringify({ ...message, buffers: buffers.map((buffer) => buffer.byteLength) }),
	);
	const size = buffers.reduce((total, buffer) => total + buffer.byteLength, header.length + 4);
	if (size > maximum) throw new Error("Notebook response exceeds the transport limit");
	const frame = new Uint8Array(size);
	new DataView(frame.buffer).setUint32(0, header.length);
	frame.set(header, 4);
	let offset = header.length + 4;
	for (const buffer of buffers) {
		frame.set(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength), offset);
		offset += buffer.byteLength;
	}
	return frame;
}

export function decodeFrame(frame: Uint8Array) {
	if (frame.byteLength < 4 || frame.byteLength > maximum) throw new Error("Invalid notebook frame size");
	const size = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0);
	if (size > frame.byteLength - 4) throw new Error("Truncated notebook frame");
	const message: WireValue = JSON.parse(new TextDecoder().decode(frame.subarray(4, size + 4)));
	if (!isRecord(message) || !Array.isArray(message.buffers)) throw new Error("Invalid notebook frame header");
	let offset = size + 4;
	const buffers = message.buffers.map((length) => {
		if (!isNumber(length) || !Number.isSafeInteger(length) || length < 0 || length > frame.byteLength - offset)
			throw new Error("Invalid notebook buffer size");
		const buffer = new DataView(frame.buffer, frame.byteOffset + offset, length);
		offset += length;
		return buffer;
	});
	if (offset !== frame.byteLength) throw new Error("Unexpected trailing notebook bytes");
	return { message, buffers };
}

/** Decode request headers with one allocation per frame, regardless of chunk boundaries. */
export async function* readMessages(chunks: AsyncIterable<Uint8Array>) {
	const header = new Uint8Array(4);
	let target = header;
	let offset = 0;
	for await (const chunk of chunks) {
		let consumed = 0;
		while (consumed < chunk.byteLength) {
			const count = Math.min(target.byteLength - offset, chunk.byteLength - consumed);
			target.set(chunk.subarray(consumed, consumed + count), offset);
			offset += count;
			consumed += count;
			if (offset < target.byteLength) continue;
			if (target === header) {
				const length = new DataView(header.buffer).getUint32(0);
				if (!length || length > maximum) throw new Error("Invalid notebook request size");
				target = new Uint8Array(length);
			} else {
				const message: WireValue = JSON.parse(new TextDecoder().decode(target));
				if (!isRecord(message)) throw new TypeError("Server request must be an object");
				yield message;
				target = header;
			}
			offset = 0;
		}
	}
	if (offset || target !== header) throw new Error("Truncated server request");
}
