import { defineConfig } from "vite-plus";

export default defineConfig({
	pack: {
		deps: {
			neverBundle: ["vite-plus"],
		},
		entry: ["src/runtime.ts", "src/vite.ts", "src/app-entry.ts", "src/build.ts", "src/dev.ts"],
		dts: true,
		outExtensions: () => ({ dts: ".d.ts", js: ".js" }),
	},
	test: {
		environment: "jsdom",
		include: ["tests/**/*.test.ts"],
	},
});
