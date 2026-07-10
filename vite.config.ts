import { defineConfig } from "vite-plus";

const generated = [
	"**/*.har",
	"**/*.html",
	"dist/**",
	"docs/_build/**",
	"docs/.jupyter-book-marimo/**",
	"packages/*/dist/**",
	"packages/pyobservablejs/src/observablejs/static/**",
];

export default defineConfig({
	fmt: {
		ignorePatterns: generated,
		printWidth: 120,
		semi: true,
		useTabs: true,
	},
	lint: {
		categories: {
			correctness: "error",
			perf: "error",
		},
		ignorePatterns: generated,
		jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
		options: {
			typeAware: true,
			typeCheck: true,
		},
		plugins: ["typescript", "unicorn", "import"],
		rules: {
			// Callback fields across the runtime and anywidget APIs are context-free.
			// Treating them as methods creates false positives on every handoff.
			"typescript/unbound-method": "off",
			"vite-plus/prefer-vite-plus-imports": "error",
		},
		overrides: [
			{
				files: ["packages/runtime/src/definition.ts"],
				rules: {
					// Notebook Kit supplies compiled cell bodies as function source.
					"typescript/no-implied-eval": "off",
				},
			},
			{
				files: ["packages/runtime/src/values.ts", "packages/runtime/src/views.ts"],
				rules: {
					// These boundaries deliberately apply JavaScript's string coercion to
					// primitive wire values and form-control values.
					"typescript/no-base-to-string": "off",
				},
			},
			{
				files: ["packages/runtime/**"],
				rules: {
					"no-restricted-imports": [
						"error",
						{
							patterns: [
								"@pyobservablejs/anywidget-bundle",
								"@pyobservablejs/anywidget-bundle/*",
								"@pyobservablejs/widget",
								"@pyobservablejs/widget/*",
							],
						},
					],
				},
			},
			{
				files: ["packages/anywidget-bundle/**"],
				rules: {
					"no-restricted-imports": [
						"error",
						{
							patterns: [
								"@pyobservablejs/runtime",
								"@pyobservablejs/runtime/*",
								"@pyobservablejs/widget",
								"@pyobservablejs/widget/*",
							],
						},
					],
				},
			},
		],
	},
	run: {
		cache: true,
	},
});
