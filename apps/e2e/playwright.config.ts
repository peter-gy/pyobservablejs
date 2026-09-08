import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: "./tests",
	timeout: 60_000,
	expect: { timeout: 15_000 },
	fullyParallel: false,
	workers: 1,
	forbidOnly: Boolean(process.env.CI),
	retries: 0,
	reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
	outputDir: "test-results",
	use: {
		baseURL: "http://127.0.0.1:27344",
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: [
		{
			command:
				"uv run --no-sync --package pyobservablejs marimo edit apps/e2e/fixtures/errors.py --headless --host 127.0.0.1 --port 27347 --no-token --session-ttl 0",
			env: { _MARIMO_CONFIG_OVERLOAD_RUNTIME_AUTO_INSTANTIATE: "true" },
			cwd: "../..",
			url: "http://127.0.0.1:27347",
			reuseExistingServer: false,
			timeout: 60_000,
			gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
		},
		{
			command: "vp exec -F @pyobservablejs/e2e vp dev --config standalone/vite.config.ts",
			cwd: "../..",
			url: "http://127.0.0.1:27346",
			reuseExistingServer: false,
			timeout: 60_000,
			gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
		},
		{
			command: "uv run --no-sync --package pyobservablejs python apps/e2e/serve_jupyter.py",
			cwd: "../..",
			url: "http://127.0.0.1:27345/lab",
			reuseExistingServer: false,
			timeout: 60_000,
			gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
		},
		{
			command:
				"uv run --no-sync --package pyobservablejs marimo run apps/e2e/fixtures/notebook.py --headless --host 127.0.0.1 --port 27344 --no-token --session-ttl 0",
			cwd: "../..",
			url: "http://127.0.0.1:27344",
			reuseExistingServer: false,
			timeout: 60_000,
			gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
		},
	],
});
