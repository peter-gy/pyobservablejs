const maximum = 64 * 1024 * 1024;

/** Encode one browser response as a big-endian header length, a JSON header, and its buffers. */
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
