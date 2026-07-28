// @ts-check

import { remarkMarimo } from "@marimo-team/mdx-marimo/remark";

const umamiWebsiteId = "a16d4cab-d28f-4a52-9fdd-46399feffea4";

/** @param {string} value */
function normalizeBaseUrl(value) {
	const path = value.trim();
	if (path === "" || path === "/") {
		return "/";
	}
	return `/${path.replace(/^\/+|\/+$/g, "")}/`;
}

const baseUrl =
	process.env.GITHUB_ACTIONS === "true" ? normalizeBaseUrl(process.env.GITHUB_PAGES_BASE_PATH ?? "/") : "/";

/** @type {import("@docusaurus/types").Config} */
const config = {
	title: "pyobservablejs",
	tagline: "Reactive Observable notebooks from Python",
	url: "https://peter-gy.github.io",
	baseUrl,
	favicon: "img/brand/pyobservablejs-favicon-on-white.png",
	headTags: [
		{
			tagName: "link",
			attributes: {
				rel: "icon",
				type: "image/svg+xml",
				sizes: "any",
				media: "(prefers-color-scheme: light)",
				href: `${baseUrl}img/brand/pyobservablejs-favicon-on-white.svg`,
			},
		},
		{
			tagName: "link",
			attributes: {
				rel: "icon",
				type: "image/svg+xml",
				sizes: "any",
				media: "(prefers-color-scheme: dark)",
				href: `${baseUrl}img/brand/pyobservablejs-favicon-on-black.svg`,
			},
		},
	],
	organizationName: "peter-gy",
	projectName: "pyobservablejs",
	onBrokenLinks: "throw",
	onBrokenAnchors: "throw",
	trailingSlash: true,
	scripts: [
		{
			src: "https://umami.peter.gy/script.js",
			defer: true,
			"data-website-id": umamiWebsiteId,
		},
	],
	markdown: {
		mermaid: true,
		hooks: {
			onBrokenMarkdownLinks: "throw",
		},
	},
	plugins: ["@orama/plugin-docusaurus-v3"],
	themes: ["@docusaurus/theme-mermaid"],
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
					remarkPlugins: [[remarkMarimo, { compiler: { uvCommand: "uv" } }]],
					editUrl: "https://github.com/peter-gy/pyobservablejs/edit/main/apps/docs/",
				},
				pages: {
					remarkPlugins: [[remarkMarimo, { compiler: { uvCommand: "uv" } }]],
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
			mermaid: {
				theme: { light: "neutral", dark: "dark" },
			},
			prism: {
				additionalLanguages: ["python"],
			},
			colorMode: {
				respectPrefersColorScheme: true,
			},
			navbar: {
				logo: {
					alt: "",
					src: "img/brand/pyobservablejs-symbol-light.svg",
					srcDark: "img/brand/pyobservablejs-symbol-dark.svg",
				},
				items: [
					{
						to: "/",
						position: "left",
						label: "Overview",
					},
					{
						type: "dropdown",
						position: "left",
						label: "Guide",
						items: [
							{ label: "Quickstart", to: "/guide/quickstart/" },
							{ label: "Create notebooks", to: "/guide/create/" },
							{ label: "Display views", to: "/guide/display/" },
							{ label: "Connect Python and Observable", to: "/guide/connect/" },
							{ label: "Customize and export", to: "/guide/customize/" },
							{ label: "Troubleshooting", to: "/guide/troubleshooting/" },
						],
					},
					{
						type: "docSidebar",
						sidebarId: "examples",
						position: "left",
						label: "Examples",
					},
					{
						type: "docSidebar",
						sidebarId: "reference",
						position: "left",
						label: "Reference",
					},
					{
						type: "search",
						position: "right",
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
						title: "Guide",
						items: [
							{ label: "Quickstart", to: "/guide/quickstart/" },
							{ label: "How it works", to: "/guide/how-it-works/" },
							{ label: "Troubleshooting", to: "/guide/troubleshooting/" },
						],
					},
					{
						title: "Explore",
						items: [
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
