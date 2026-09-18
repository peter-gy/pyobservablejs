import { mountNotebook } from "@pyobservablejs/runtime";
import { encodeFrame } from "@pyobservablejs/protocol";
import { createService } from "./service";

const root = document.body.appendChild(document.createElement("main"));
const service = createService(
	(message, buffers) => {
		const frame = encodeFrame(message, buffers);
		void fetch("/response", { method: "POST", body: frame }).catch((cause) => console.error(cause));
	},
	(source, options) => mountNotebook(root, source, options),
);
export const receive = service.receive;
