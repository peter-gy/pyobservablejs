import { isBuiltin } from "node:module";
import { defineConfig } from "vite-plus";
export default defineConfig({
	define: { "process.env.WS_NO_BUFFER_UTIL": "true", "process.env.WS_NO_UTF_8_VALIDATE": "true" },
	ssr: { noExternal: true },
	build: {
		ssr: "src/index.ts",
		target: "esnext",
		outDir: "dist",
		lib: { entry: "src/index.ts", formats: ["es"], fileName: () => "server.js" },
		minify: true,
		rolldownOptions: {
			external: [/^node:/, "playwright-core"],
			output: {
				paths: (id) =>
					id === "playwright-core"
						? "./driver/index.mjs"
						: isBuiltin(id) && !id.startsWith("node:")
							? `node:${id}`
							: id,
				entryFileNames: "server.js",
				chunkFileNames: "[name].js",
			},
		},
	},
});
