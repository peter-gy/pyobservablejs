import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

export default defineConfig({
	root: fileURLToPath(new URL(".", import.meta.url)),
	resolve: {
		alias: [
			{
				find: /^@pyobservablejs\/runtime$/,
				replacement: fileURLToPath(new URL("../../../packages/runtime/dist/index.js", import.meta.url)),
			},
			{
				find: /^@pyobservablejs\/runtime\/values$/,
				replacement: fileURLToPath(new URL("../../../packages/runtime/dist/value-api.js", import.meta.url)),
			},
		],
	},
	server: { host: "127.0.0.1", port: 27346, strictPort: true },
});
