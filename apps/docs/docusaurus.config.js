// @ts-check

import { remarkMarimo } from "@marimo-team/mdx-marimo/remark";

/** @param {string} value */
function normalizeBaseUrl(value) {
	const path = value.trim();
	if (path === "" || path === "/") {
		return "/";
	}
	return `/${path.replace(/^\/+|\/+$/g, "")}/`;
}

/** @type {import("@docusaurus/types").Config} */
const config = {
	title: "pyobservablejs",
	tagline: "Observable JavaScript notebooks from Python",
	url: "https://peter-gy.github.io",
	baseUrl: normalizeBaseUrl(process.env.BASE_PATH ?? "/"),
	organizationName: "peter-gy",
	projectName: "pyobservablejs",
	onBrokenLinks: "throw",
	onBrokenAnchors: "throw",
	trailingSlash: true,
	markdown: {
		hooks: {
			onBrokenMarkdownLinks: "throw",
		},
	},
	i18n: {
		defaultLocale: "en",
		locales: ["en"],
	},
	presets: [
		[
			"classic",
			/** @type {import("@docusaurus/preset-classic").Options} */
			({
				docs: {
					routeBasePath: "/",
					sidebarPath: "./sidebars.js",
					remarkPlugins: [remarkMarimo],
					editUrl: "https://github.com/peter-gy/pyobservablejs/edit/main/apps/docs/",
				},
				blog: false,
				theme: {
					customCss: "./src/css/custom.css",
				},
			}),
		],
	],
	themeConfig:
		/** @type {import("@docusaurus/preset-classic").ThemeConfig} */
		({
			prism: {
				additionalLanguages: ["python"],
			},
			colorMode: {
				respectPrefersColorScheme: true,
			},
			navbar: {
				title: "pyobservablejs",
				items: [
					{
						type: "docSidebar",
						sidebarId: "docs",
						position: "left",
						label: "Documentation",
					},
					{
						href: "https://github.com/peter-gy/pyobservablejs",
						label: "GitHub",
						position: "right",
					},
				],
			},
			footer: {
				style: "dark",
				links: [
					{
						title: "Documentation",
						items: [
							{ label: "Getting started", to: "/getting-started/" },
							{ label: "Examples", to: "/examples/" },
							{ label: "API reference", to: "/reference/" },
						],
					},
					{
						title: "Project",
						items: [
							{ label: "GitHub", href: "https://github.com/peter-gy/pyobservablejs" },
							{ label: "PyPI", href: "https://pypi.org/project/pyobservablejs/" },
						],
					},
				],
			},
		}),
};

export default config;
