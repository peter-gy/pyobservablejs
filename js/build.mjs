import * as esbuild from "esbuild";
import { watch } from "node:fs";
import { mkdir, rm } from "node:fs/promises";

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
	await esbuild.build({
		assetNames: "widget",
		bundle: true,
		entryNames: "widget",
		entryPoints: ["js/widget/index.ts"],
		format: "esm",
		minify: true,
		outdir,
		sourcemap: args.has("--sourcemap=inline") ? "inline" : false,
	});
}
