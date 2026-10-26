import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

// Happy DOM imports Node built-ins. The embedded host is a bare V8 isolate with
// web APIs, so each built-in resolves to a shim backed by those APIs.
const shims = {
	buffer: "buffer",
	child_process: "child-process",
	crypto: "crypto",
	fs: "fs",
	http: "http",
	https: "http",
	net: "net",
	path: "path",
	perf_hooks: "perf-hooks",
	stream: "stream",
	"stream/web": "stream-web",
	url: "url",
	util: "util",
	vm: "vm",
	ws: "ws",
	zlib: "zlib",
};

export default defineConfig({
	// Happy DOM composes its default user agent from these two fields.
	define: { "process.platform": JSON.stringify("linux"), "process.arch": JSON.stringify("x64") },
	resolve: {
		alias: Object.entries(shims).map(([name, file]) => ({
			find: new RegExp(`^(?:node:)?${name.replace("/", "\\/")}$`),
			replacement: fileURLToPath(new URL(`./src/node/${file}.ts`, import.meta.url)),
		})),
	},
	build: {
		target: "esnext",
		// The Rust engine crate embeds every chunk of this bundle.
		outDir: "../engine-rust/bundle",
		emptyOutDir: true,
		lib: { entry: "src/embedded.ts", formats: ["es"], fileName: () => "engine.js" },
		minify: true,
		rolldownOptions: { output: { chunkFileNames: "[name].js", minify: true } },
	},
});
