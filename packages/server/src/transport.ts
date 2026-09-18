import { encodeFrame, readMessages, type WireRecord } from "@pyobservablejs/protocol";
import process from "node:process";

export type Message = WireRecord;

export function send<Message extends object>(message: Message, buffers: readonly DataView[] = []): void {
	process.stdout.write(encodeFrame(message, buffers));
}

export async function receive(handle: (message: Message) => void): Promise<void> {
	for await (const message of readMessages(process.stdin)) handle(message);
}
