import { expect, test } from "vite-plus/test";
import { encodeFrame } from "@pyobservablejs/protocol";

test("response frames carry a JSON header followed by binary buffers in order", () => {
	const first = new DataView(new Uint8Array([1, 2, 3]).buffer);
	const second = new DataView(new Uint8Array([9, 8, 7, 6, 5]).buffer, 1, 2);
	const frame = encodeFrame({ type: "response", id: "λ" }, [first, second]);
	const length = new DataView(frame.buffer).getUint32(0);
	const header = JSON.parse(new TextDecoder().decode(frame.subarray(4, 4 + length)));
	expect(header).toEqual({ type: "response", id: "λ", buffers: [3, 2] });
	expect([...frame.subarray(4 + length)]).toEqual([1, 2, 3, 8, 7]);
});
