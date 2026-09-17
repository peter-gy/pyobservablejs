import { defineConfig } from "vite-plus";
export default defineConfig({
	build: {
		target: "esnext",
		outDir: "dist/browser",
		lib: { entry: "src/browser.ts", formats: ["es"], fileName: () => "browser.js" },
		minify: true,
		rolldownOptions: { output: { chunkFileNames: "[name].js" } },
	},
});
