// @ts-check

/** @type {import("@docusaurus/plugin-content-docs").SidebarsConfig} */
const sidebars = {
	docs: [
		{
			type: "category",
			label: "Start",
			collapsed: false,
			collapsible: false,
			items: ["index", "quickstart", "mental-model"],
		},
		{
			type: "category",
			label: "Build notebooks",
			link: {
				type: "generated-index",
				title: "Build notebooks",
				slug: "/create",
				description: "Author cells, load notebooks, and connect files or modules.",
			},
			items: ["create/author-cells", "create/notebook-kit-html", "create/observablehq", "create/files-and-modules"],
		},
		{
			type: "category",
			label: "Render views",
			link: {
				type: "generated-index",
				title: "Render views",
				slug: "/render",
				description: "Display a notebook or select keyed cells for one view.",
			},
			items: ["render/display-views", "render/select-cells"],
		},
		{
			type: "category",
			label: "Connect state",
			link: {
				type: "generated-index",
				title: "Connect state",
				slug: "/connect",
				description: "Send Python values, read browser results, and synchronize inputs.",
			},
			items: ["connect/python-to-observable", "connect/observable-to-python", "connect/bidirectional-inputs"],
		},
		{
			type: "category",
			label: "Advanced",
			link: {
				type: "generated-index",
				title: "Advanced",
				slug: "/advanced",
				description: "Compose views, inspect dependencies, customize rendering, and import trusted sources.",
			},
			items: [
				"render/widget-composition",
				"connect/dependency-graph",
				"customize/themes-and-pinned-source",
				"customize/export-notebook-kit-html",
				"customize/browser-execution",
				"pyobservablejs-or-pyobsplot",
			],
		},
		{
			type: "category",
			label: "Recipes",
			link: {
				type: "generated-index",
				title: "Recipes",
				slug: "/recipes",
				description: "Complete workflows with source and rendered output.",
			},
			items: [
				"recipes/python-data-to-chart",
				"recipes/split-notebook-into-views",
				"recipes/coordinate-python-and-browser-inputs",
				"recipes/notebook-with-local-files",
			],
		},
		"troubleshooting",
		{
			type: "category",
			label: "API reference",
			link: { type: "doc", id: "reference/index" },
			items: [
				"reference/notebook",
				"reference/notebook-view-and-cell",
				"reference/cell-helpers",
				"reference/variables-and-serialization",
				"reference/values-and-graph",
				"reference/source-constructors",
				"reference/file-attachments",
				"reference/themes",
				"reference/types",
			],
		},
	],
};

export default sidebars;
