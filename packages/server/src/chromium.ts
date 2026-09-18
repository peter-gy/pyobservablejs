import { chromium, type BrowserContext, type Route } from "playwright-core";
import process from "node:process";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { decodeFrame, type WireValue } from "@pyobservablejs/protocol";
import { isObjectValue, isString } from "@pyobservablejs/runtime/values";
import { receive, send } from "./transport";

const origin = "https://observablejs.invalid";
const network: WireValue = JSON.parse(process.argv[3] ?? "false");
if (network !== true && network !== false && (!Array.isArray(network) || !network.every(isString)))
	throw new TypeError("Invalid browser network policy");
const allowed = (url: URL) =>
	network === true || (Array.isArray(network) && network.some((host) => host === url.host || host === url.hostname));
const assets = new URL("./browser/", import.meta.url);

async function prepareChromium(): Promise<void> {
	try {
		await access(chromium.executablePath());
		return;
	} catch (cause) {
		if (!isObjectValue(cause) || !("code" in cause) || cause.code !== "ENOENT") throw cause;
	}
	// Use the bundled, version-pinned installer through the same Deno binary.
	// Browser installation is needed only when the Chromium host is first selected.
	const cli = fileURLToPath(new URL("./driver/cli.js", import.meta.url));
	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[
				"run",
				"--allow-all",
				"--no-config",
				"--no-npm",
				"--unstable-detect-cjs",
				cli,
				"install",
				"chromium",
				"--no-shell",
			],
			{ stdio: ["ignore", "pipe", "inherit"] },
		);
		child.stdout?.on("data", (data) => process.stderr.write(data));
		const terminate = () => {
			child.kill("SIGTERM");
		};
		process.once("SIGTERM", terminate);
		child.once("error", (cause) => {
			process.off("SIGTERM", terminate);
			reject(cause);
		});
		child.once("exit", (code) => {
			process.off("SIGTERM", terminate);
			if (code === 0) resolve();
			else reject(new Error(`Chromium installation failed with exit code ${code}`));
		});
	});
}

async function routeRequest(route: Route): Promise<void> {
	const request = route.request();
	const url = new URL(request.url());
	if (url.origin !== origin) {
		if (allowed(url)) await route.continue();
		else await route.abort("accessdenied");
		return;
	}
	if (url.pathname === "/response" && request.method() === "POST") {
		const frame = request.postDataBuffer();
		if (!frame) throw new Error("Browser response has no frame");
		const { message, buffers } = decodeFrame(frame);
		send(message, buffers);
		await route.fulfill({ status: 204 });
		return;
	}
	if (url.pathname === "/") {
		await route.fulfill({
			contentType: "text/html",
			body: '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>',
		});
		return;
	}
	if (!url.pathname.startsWith("/browser/")) {
		await route.fulfill({ status: 404 });
		return;
	}
	const asset = new URL(url.pathname.slice("/browser/".length), assets);
	if (!asset.href.startsWith(assets.href)) {
		await route.fulfill({ status: 404 });
		return;
	}
	try {
		await route.fulfill({
			body: await readFile(asset),
			contentType: asset.pathname.endsWith(".css") ? "text/css" : "text/javascript",
		});
	} catch (cause) {
		if (!isObjectValue(cause) || !("code" in cause) || cause.code !== "ENOENT") throw cause;
		await route.fulfill({ status: 404 });
	}
}

async function configureNetwork(context: BrowserContext): Promise<void> {
	await context.route("**/*", routeRequest);
	await context.routeWebSocket("**/*", async (route) => {
		if (allowed(new URL(route.url()))) route.connectToServer();
		else await route.close({ code: 1008, reason: "Notebook network access denied" });
	});
}

console.log = console.info = console.debug = console.error.bind(console);
await prepareChromium();
const browser = await chromium.launch({ headless: true, channel: "chromium" });
try {
	const context = await browser.newContext({
		viewport: { width: 640, height: 480 },
		serviceWorkers: "block",
		// Request routes still enforce the selected host policy for private networks.
		permissions: ["local-network-access"],
	});
	await configureNetwork(context);
	const page = await context.newPage();
	page.on("console", (message) => console.error(message.text()));
	await page.goto(origin);
	const moduleUrl = `${origin}/browser/browser.js`;
	await page.evaluate(async (url) => {
		await import(/* @vite-ignore */ url);
	}, moduleUrl);
	send({ type: "ready", protocol: 1 });
	let commands = Promise.resolve();
	await receive((message) => {
		commands = commands
			.then(async () => {
				if (message.operation === "screenshot") {
					const png = await page.screenshot({ fullPage: true, animations: "disabled" });
					send(
						{
							type: "response",
							id: message.id,
							result: { cell: null, name: null, revision: 0, format: "bytes", binary: true, mimeType: "image/png" },
						},
						[new DataView(png.buffer, png.byteOffset, png.byteLength)],
					);
					return;
				}
				await page.evaluate(
					async ({ moduleUrl, request }) => {
						const api = await import(/* @vite-ignore */ moduleUrl);
						api.receive(JSON.parse(request));
					},
					{ moduleUrl, request: JSON.stringify(message) },
				);
			})
			.catch((cause) => {
				console.error(cause);
				process.stdin.destroy();
			});
	});
} finally {
	await browser.close();
}
