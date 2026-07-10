import { defineConfig } from "vitest/config";

const fromRoot = (path: string) => new URL(path, import.meta.url).pathname;

export default defineConfig({
	resolve: {
		alias: {
			"@": fromRoot("./js"),
		},
	},
	test: {
		css: true,
		deps: {
			web: {
				transformCss: true,
			},
		},
	},
});
