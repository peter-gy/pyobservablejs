import { evaluateNotebook } from "@pyobservablejs/runtime/headless";
import { receive, send } from "./transport";
import { createService } from "./service";
const service = createService(send, evaluateNotebook);
send({ type: "ready", protocol: 1 });
try {
	await receive(service.receive);
} finally {
	service.close();
}
