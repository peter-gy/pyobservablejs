// @ts-check

/** @type {import("@docusaurus/plugin-content-docs").SidebarsConfig} */
const sidebars = {
	guide: [
		{
			type: "category",
			label: "Introduction",
			collapsed: false,
			link: {
				type: "generated-index",
				title: "Guide",
				slug: "/guide",
				description: "Build, display, connect, and customize Observable notebooks from Python.",
			},
			items: ["guide/quickstart", "guide/how-it-works", "guide/choose-a-library"],
		},
		{
			type: "category",
			label: "Create notebooks",
			link: {
				type: "generated-index",
				title: "Create notebooks",
				slug: "/guide/create",
				description: "Author cells, load notebook documents, import Observable notebooks, and add files.",
			},
			items: [
				"guide/create/cells",
				"guide/create/notebook-kit-html",
				"guide/create/observable-notebooks",
				"guide/create/files-and-modules",
			],
		},
		{
			type: "category",
			label: "Display views",
			link: {
				type: "generated-index",
				title: "Display views",
				slug: "/guide/display",
				description: "Display whole notebooks, select cells, and compose views in notebook layouts.",
			},
			items: ["guide/display/notebooks", "guide/display/cells", "guide/display/compose-views"],
		},
		{
			type: "category",
			label: "Connect Python and Observable",
			link: {
				type: "generated-index",
				title: "Connect Python and Observable",
				slug: "/guide/connect",
				description: "Send Python values, read browser results, share inputs, and inspect dependencies.",
			},
			items: [
				"guide/connect/python-values",
				"guide/connect/browser-results",
				"guide/connect/shared-inputs",
				"guide/connect/dependencies",
			],
		},
		{
			type: "category",
			label: "Customize and export",
			link: {
				type: "generated-index",
				title: "Customize and export",
				slug: "/guide/customize",
				description: "Set themes, show source, export HTML, and understand browser execution.",
			},
			items: ["guide/customize/themes-and-source", "guide/customize/export-html", "guide/customize/browser-execution"],
		},
		"guide/troubleshooting",
	],
	examples: [
		{
			type: "category",
			label: "Examples",
			collapsed: false,
			link: { type: "doc", id: "examples/index" },
			items: [
				"examples/python-data-and-chart",
				"examples/python-and-browser-inputs",
				"examples/split-notebook-views",
				"examples/notebook-with-files",
			],
		},
	],
	reference: [
		{
			type: "category",
			label: "API reference",
			collapsed: false,
			items: ["reference/index"],
		},
		{
			type: "category",
			label: "Notebooks and cells",
			items: ["reference/notebook", "reference/notebook-view-and-cell", "reference/cell-helpers"],
		},
		{
			type: "category",
			label: "State and values",
			items: ["reference/variables-and-serialization", "reference/values-and-graph", "reference/types"],
		},
		{
			type: "category",
			label: "Sources and presentation",
			items: ["reference/source-constructors", "reference/file-attachments", "reference/themes"],
		},
	],
};

export default sidebars;
