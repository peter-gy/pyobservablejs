import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import docusaurusPluginLlms from "docusaurus-plugin-llms";

const MARIMO_EXECUTION_FENCE = "python marimo echo=false server-output=false";
const codeBlockPattern = () => /^```([^\r\n]*)\r?\n([\s\S]*?)^```[ \t]*(?:\r?\n|$)/gm;
const normalizeRoute = (value) => {
	const route = `/${value.replace(/^\/+|\/+$/g, "")}`;
	return route === "/" ? route : route.replace(/\/+$/, "");
};

export function validateLlmsLinks(source, baseUrl, routesPaths) {
	const base = baseUrl === "/" ? "/" : `/${baseUrl.replace(/^\/+|\/+$/g, "")}/`;
	const routes = new Set(routesPaths.map(normalizeRoute));
	const destinations = [...source.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);

	if (destinations.length === 0) {
		throw new Error("llms.txt contains no documentation links");
	}

	for (const destination of destinations) {
		if (!destination.startsWith(base)) {
			throw new Error(`llms.txt link does not use the configured base URL: ${destination}`);
		}
		const route = normalizeRoute(destination.split(/[?#]/, 1)[0]);
		if (!routes.has(route)) {
			throw new Error(`llms.txt link does not resolve to a Docusaurus route: ${destination}`);
		}
	}
}

export function cleanLlmsFullText(source) {
	const blocks = [...source.matchAll(codeBlockPattern())].map((match) => ({
		info: match[1],
		body: match[2],
	}));
	const visiblePython = new Set(blocks.filter((block) => block.info === "python").map((block) => block.body));
	const executionBlocks = blocks.filter((block) => block.info === MARIMO_EXECUTION_FENCE);
	const unmatched = executionBlocks.find((block) => !visiblePython.has(block.body));

	if (unmatched) {
		throw new Error("llms-full.txt contains a marimo execution cell with no matching visible Python example");
	}

	return source
		.replace(/^```marimo-config\r?\n[\s\S]*?^```[ \t]*(?:\r?\n|$)/gm, "")
		.replace(/^```python marimo echo=false server-output=false\r?\n[\s\S]*?^```[ \t]*(?:\r?\n|$)/gm, "")
		.replace(/\[([^\]]+)\]\((?!https?:\/\/|mailto:|#)[^)\r\n]*\.mdx(?:#[^)\r\n]*)?\)/g, "$1")
		.replace(/\n{3,}/g, "\n\n")
		.trimStart();
}

export default function pyobservablejsLlms(context, options) {
	const plugin = docusaurusPluginLlms(context, options);

	return {
		name: "pyobservablejs-llms",
		async postBuild(props) {
			await plugin.postBuild(props);
			const indexPath = path.join(props.outDir, "llms.txt");
			const fullPath = path.join(props.outDir, "llms-full.txt");
			const [indexSource, fullSource] = await Promise.all([readFile(indexPath, "utf8"), readFile(fullPath, "utf8")]);
			validateLlmsLinks(indexSource, props.siteConfig.baseUrl, props.routesPaths);
			await writeFile(fullPath, cleanLlmsFullText(fullSource), "utf8");
		},
	};
}
