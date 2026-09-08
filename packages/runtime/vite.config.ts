import { defineConfig } from "vite-plus";

export default defineConfig({
	pack: {
		dts: true,
		entry: ["src/index.ts", "src/value-api.ts", "src/inspect-api.ts"],
		platform: "browser",
		deps: { alwaysBundle: [/\.css(?:\?.*)?$/] },
	},
	test: {
		environment: "jsdom",
		include: ["tests/**/*.test.ts"],
	},
});
