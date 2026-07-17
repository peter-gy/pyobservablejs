// @ts-check

/** @type {import("@docusaurus/plugin-content-docs").SidebarsConfig} */
const sidebars = {
	docs: [
		{
			type: "category",
			label: "Start",
			collapsed: false,
			collapsible: false,
			items: ["index", "quickstart", "mental-model", "pyobservablejs-or-pyobsplot"],
		},
		{
			type: "category",
			label: "Create notebooks",
			link: {
				type: "generated-index",
				title: "Create notebooks",
				slug: "/create",
				description:
					"Author cells from Python, or load existing Notebook Kit and ObservableHQ sources.",
			},
			items: [
				"create/author-cells",
				"create/notebook-kit-html",
				"create/observablehq",
				"create/files-and-modules",
			],
		},
		{
			type: "category",
			label: "Render and compose",
			link: {
				type: "generated-index",
				title: "Render and compose",
				slug: "/render",
				description:
					"Display views in anywidget hosts, select the cells each view renders, and manage view lifecycle.",
			},
			items: ["render/display-views", "render/select-cells", "render/view-lifecycle"],
		},
		{
			type: "category",
			label: "Connect Python and the browser",
			link: {
				type: "generated-index",
				title: "Connect Python and the browser",
				slug: "/connect",
				description:
					"Send Python values into the reactive graph, read browser values back, and inspect the dependency graph.",
			},
			items: [
				"connect/python-to-observable",
				"connect/observable-to-python",
				"connect/bidirectional-inputs",
				"connect/dependency-graph",
			],
		},
		{
			type: "category",
			label: "Customize and serialize",
			link: {
				type: "generated-index",
				title: "Customize and serialize",
				slug: "/customize",
				description:
					"Themes, pinned source panels, Notebook Kit HTML export, and browser execution.",
			},
			items: [
				"customize/themes-and-pinned-source",
				"customize/export-notebook-kit-html",
				"customize/browser-execution",
			],
		},
		{
			type: "category",
			label: "Recipes",
			link: {
				type: "generated-index",
				title: "Recipes",
				slug: "/recipes",
				description: "Complete live workflows with source and rendered output.",
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
			],
		},
	],
};

export default sidebars;
