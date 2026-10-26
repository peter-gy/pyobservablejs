import { unavailable } from "./unavailable";

class NodeStream {
	constructor() {
		unavailable("Node streams")();
	}
}
export default {
	Readable: NodeStream,
	Writable: NodeStream,
	Transform: NodeStream,
	PassThrough: NodeStream,
	pipeline: unavailable("Node stream pipelines"),
};
