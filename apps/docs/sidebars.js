// @ts-check

/** @type {import("@docusaurus/plugin-content-docs").SidebarsConfig} */
const sidebars = {
	docs: [
		"index",
		"getting-started",
		{
			type: "category",
			label: "Examples",
			link: { type: "doc", id: "examples/index" },
			items: ["examples/python-data-plot", "examples/reactive-inputs", "examples/html-notebook-files"],
		},
		{
			type: "category",
			label: "Guides",
			link: { type: "doc", id: "guides/index" },
			items: [
				"guides/views-and-composition",
				"guides/notebook-runtime",
				"guides/author-cells",
				"guides/python-variables",
				"guides/cell-values",
				"guides/source-html",
				"guides/observablehq",
				"guides/themes",
			],
		},
		{
			type: "category",
			label: "Reference",
			link: { type: "doc", id: "reference/index" },
			items: [
				"reference/notebook",
				"reference/cells",
				"reference/variables",
				"reference/file-attachments",
				"reference/source-notebooks",
				"reference/values-and-graph",
				"reference/notebook-themes",
			],
		},
	],
};

export default sidebars;
