import * as esbuild from "esbuild";
import { watch } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const args = new Set(process.argv.slice(2));
const outdir = "src/pyobservablejs/static";

if (args.has("--watch")) {
	await buildAndWatch();
} else {
	await buildWidget();
}

async function buildAndWatch() {
	let building = false;
	let queued = false;

	const rebuild = async () => {
		if (building) {
			queued = true;
			return;
		}
		building = true;
		try {
			await buildWidget();
			console.log("Built widget.");
		} catch (error) {
			console.error(error);
		} finally {
			building = false;
			if (queued) {
				queued = false;
				void rebuild();
			}
		}
	};

	await rebuild();
	const watcher = watch("js", { recursive: true }, () => {
		void rebuild();
	});
	console.log("Watching widget sources...");
	process.on("SIGINT", () => {
		watcher.close();
		process.exit(0);
	});
}

async function buildWidget() {
	await rm(outdir, { recursive: true, force: true });
	await mkdir(outdir, { recursive: true });
	const sourcemap = args.has("--sourcemap=inline") ? "inline" : false;
	const appBuild = await esbuild.build({
		bundle: true,
		chunkNames: "chunks/[name]-[hash]",
		entryNames: "chunks/[name]-[hash]",
		entryPoints: ["js/widget/app.ts"],
		format: "esm",
		metafile: true,
		minify: true,
		outdir,
		sourcemap,
		splitting: true,
	});
	const appChunk = entryOutputPath(appBuild.metafile, "js/widget/app.ts");
	const appCssOutputs = cssOutputPaths(appBuild.metafile);
	await esbuild.build({
		bundle: true,
		entryPoints: ["js/widget/index.ts"],
		format: "esm",
		minify: true,
		outfile: path.join(outdir, "widget.js"),
		define: { __PYOBSERVABLEJS_APP_CHUNK__: JSON.stringify(appChunk) },
		sourcemap,
	});
	await esbuild.build({
		bundle: true,
		entryPoints: ["js/widget/widget.css"],
		minify: true,
		outfile: path.join(outdir, "widget.css"),
		sourcemap: false,
	});
	await foldCssOutputs(appCssOutputs, path.join(outdir, "widget.css"));
}

function entryOutputPath(metafile, entryPoint) {
	for (const [outputPath, output] of Object.entries(metafile.outputs)) {
		if (output.entryPoint === entryPoint && outputPath.endsWith(".js")) {
			return path.relative(outdir, outputPath).split(path.sep).join("/");
		}
	}
	throw new Error(`Could not find build output for ${entryPoint}`);
}

function cssOutputPaths(metafile) {
	return Object.keys(metafile.outputs).filter((outputPath) => outputPath.endsWith(".css"));
}

async function foldCssOutputs(cssOutputs, targetPath) {
	if (cssOutputs.length === 0) return;
	const imports = new Set();
	const bodies = [];
	const bodyKeys = new Set();
	const cssParts = await Promise.all(
		[targetPath, ...cssOutputs].map(async (cssPath) => {
			return splitLeadingImports(await readFile(cssPath, "utf8"));
		}),
	);
	for (const split of cssParts) {
		for (const item of split.imports) imports.add(item);
		const body = split.body.trim();
		if (body && !bodyKeys.has(body)) {
			bodyKeys.add(body);
			bodies.push(body);
		}
	}
	const pieces = [...imports, ...bodies];
	await writeFile(targetPath, `${pieces.join("\n")}\n`, "utf8");
	await Promise.all(cssOutputs.map((cssPath) => rm(cssPath, { force: true })));
}

function splitLeadingImports(css) {
	const imports = [];
	let body = css.trimStart();
	while (body.startsWith("@import")) {
		const match = body.match(/^@import[^;]+;\s*/);
		if (!match) break;
		imports.push(match[0].trim());
		body = body.slice(match[0].length).trimStart();
	}
	return { imports, body };
}
