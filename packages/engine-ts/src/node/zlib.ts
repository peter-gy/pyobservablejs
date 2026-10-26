import { unavailable } from "./unavailable";

const decompress = unavailable("Node decompression");
export default {
	constants: {},
	inflateSync: decompress,
	gunzipSync: decompress,
	brotliDecompressSync: decompress,
	createInflate: decompress,
	createInflateRaw: decompress,
	createGunzip: decompress,
	createBrotliDecompress: decompress,
};
