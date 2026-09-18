import { expect, test } from "vite-plus/test";
import { readMessages, type WireValue, type WireRecord } from "@pyobservablejs/protocol";

function request(value: WireValue): Uint8Array {
	const body = new TextEncoder().encode(JSON.stringify(value));
	const frame = new Uint8Array(body.byteLength + 4);
	new DataView(frame.buffer).setUint32(0, body.byteLength);
	frame.set(body, 4);
	return frame;
}

async function collect(chunks: Uint8Array[]) {
	async function* stream() {
		yield* chunks;
	}
	const messages: WireRecord[] = [];
	for await (const message of readMessages(stream())) messages.push(message);
	return messages;
}

test("request framing handles fragmented headers, UTF-8 bodies, and coalesced messages", async () => {
	const messages = [{ text: "λ" }, { operation: "snapshot" }];
	const frames = messages.map(request);
	const wire = new Uint8Array(frames.reduce((sum, frame) => sum + frame.byteLength, 0));
	let offset = 0;
	for (const frame of frames) {
		wire.set(frame, offset);
		offset += frame.byteLength;
	}
	const unicode = wire.indexOf(0xce);
	const nextHeader = frames[0]!.byteLength + 2;
	expect(
		await collect([
			wire.subarray(0, 2),
			wire.subarray(2, unicode + 1),
			wire.subarray(unicode + 1, nextHeader),
			wire.subarray(nextHeader),
		]),
	).toEqual(messages);
	expect(await collect([wire])).toEqual(messages);
});

test("request framing rejects invalid envelopes and incomplete frames", async () => {
	const frame = request({ operation: "read" });
	await Promise.all(
		[1, 4, frame.byteLength - 1].map((length) =>
			expect(collect([frame.subarray(0, length)])).rejects.toThrow("Truncated"),
		),
	);
	await expect(collect([new Uint8Array([4, 0, 0, 1])])).rejects.toThrow("request size");
	await expect(collect([request([])])).rejects.toThrow("must be an object");
});
