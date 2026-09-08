import { expect, test } from "./fixture";

test.use({ baseURL: "http://127.0.0.1:27346" });

test("mounts source with hidden dependencies and preserves native JavaScript identities", async ({ page }) => {
	await page.goto("/");
	await expect(page.getByLabel("Native result")).toHaveText("21 on 2026-01-02, missing=true");
	await expect(page.getByText("Native DOM element", { exact: true })).toBeVisible();
	await expect(page.getByLabel("Native identity")).toHaveText("All native identities preserved");
	await expect(page.getByLabel("Selection graph")).toHaveText("Graph cells: 1, 2. Result cells: 1.");
	await expect(page.locator("#cell-1")).toBeHidden();
});

test("updates and releases injected variables while distinguishing browser input events", async ({ page }) => {
	await page.goto("/?scenario=inputs");
	await expect(page.getByLabel("Input state")).toHaveText("Settled total=6");
	await page.getByRole("button", { name: "Inject multiplier", exact: true }).click();
	await expect(page.getByLabel("Total", { exact: true })).toHaveText("10");
	await page.getByRole("slider", { name: "Amount", exact: true }).press("End");
	await expect(page.getByLabel("Input events")).toHaveText("1 interactions: amount=10");
	await expect(page.getByLabel("Input state")).toHaveText("Settled total=50");
	await page.getByRole("button", { name: "Set input programmatically", exact: true }).click();
	await expect(page.getByLabel("Input state")).toHaveText("Settled total=20");
	await expect(page.getByLabel("Input events")).toHaveText("1 interactions: amount=10");
	await page.getByRole("button", { name: "Restore authored variables", exact: true }).click();
	await expect(page.getByLabel("Input state")).toHaveText("Settled total=12");
});

test("preserves native date values through browser and programmatic input", async ({ page }) => {
	await page.goto("/?scenario=native-inputs");
	await page.getByLabel("Day", { exact: true }).fill("2025-03-04");
	await expect(page.getByLabel("day event", { exact: true })).toHaveText("Date:2025-03-04");
	await expect(page.getByLabel("day value", { exact: true })).toHaveText("Date:2025-03-04");
	await page.getByRole("button", { name: "Set day", exact: true }).click();
	await expect(page.getByLabel("day value", { exact: true })).toHaveText("Date:2025-05-06");
	await expect(page.getByLabel("day event", { exact: true })).toHaveText("Date:2025-03-04");
	await page.getByRole("button", { name: "Clear day", exact: true }).click();
	await expect(page.getByLabel("day value", { exact: true })).toHaveText("null");
	await expect(page.getByLabel("Day", { exact: true })).toHaveValue("");
});

test("preserves native files and file lists while allowing variable ownership", async ({ page }) => {
	await page.goto("/?scenario=native-inputs");
	await page.getByLabel("Upload", { exact: true }).setInputFiles({
		name: "sample.txt",
		mimeType: "text/plain",
		buffer: Buffer.from("sample"),
	});
	await expect(page.getByLabel("upload event", { exact: true })).toHaveText("File:sample.txt:6");
	await expect(page.getByLabel("upload value", { exact: true })).toHaveText("File:sample.txt:6");
	await page.getByLabel("Uploads", { exact: true }).setInputFiles([
		{ name: "first.txt", mimeType: "text/plain", buffer: Buffer.from("one") },
		{ name: "second.txt", mimeType: "text/plain", buffer: Buffer.from("two") },
	]);
	await expect(page.getByLabel("uploads event", { exact: true })).toHaveText("FileList:first.txt,second.txt");
	await expect(page.getByLabel("uploads value", { exact: true })).toHaveText("FileList:first.txt,second.txt");
	await page.getByRole("button", { name: "Inject file", exact: true }).click();
	await expect(page.getByLabel("upload value", { exact: true })).toHaveText("File:injected.txt:6");
	await expect(page.getByLabel("Upload", { exact: true })).toHaveValue(/sample\.txt$/);
	await expect(page.getByLabel("upload event", { exact: true })).toHaveText("File:sample.txt:6");
});

test("publishes native button and checkbox clicks", async ({ page }) => {
	await page.goto("/?scenario=native-inputs");
	await page.getByRole("button", { name: "Count click", exact: true }).click();
	await expect(page.getByLabel("action event", { exact: true })).toHaveText("1");
	await expect(page.getByLabel("action value", { exact: true })).toHaveText("1");
	await page.getByLabel("Enabled", { exact: true }).check();
	await expect(page.getByLabel("enabled event", { exact: true })).toHaveText("true");
	await expect(page.getByLabel("enabled value", { exact: true })).toHaveText("true");
});

test("installs complete notebook and source styles within a shadow root", async ({ page }) => {
	await page.goto("/?scenario=shadow");
	await expect(page.getByRole("heading", { name: "Inside the shadow root", exact: true })).toBeVisible();
	const source = page.getByLabel("JavaScript source", { exact: true });
	await expect(source).toBeVisible();
	await expect(source).toHaveCSS("white-space", "pre");
	await expect(source).toHaveCSS("overflow-x", "auto");
	await expect(source).toHaveCSS("font-family", /monospace/);
	await expect(page.locator(".pyobservablejs-notebook")).toHaveCSS("color-scheme", "dark");
	await expect(page.locator(".pyobservablejs-notebook")).toHaveCSS("box-sizing", "border-box");
});

test("cancels pending work, permits remount, and keeps sibling disposal independent", async ({ page }) => {
	await page.goto("/?scenario=lifecycle");
	await expect(page.getByLabel("Async evaluation")).toHaveText("Started");
	await expect(page.getByLabel("Sibling value")).toHaveText("Independent");
	await page.getByRole("button", { name: "Cancel and remount", exact: true }).click();
	await expect(page.getByText("Replacement mount", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Resolve cancelled work", exact: true }).click();
	await expect(page.getByLabel("Sibling value")).toHaveText("Still independent");
	await expect(page.getByLabel("Sibling state")).toHaveText("Settled");
	await expect(page.getByLabel("Cancelled publications")).toHaveText("0");
	await expect(page.getByText("Stale output", { exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "Dispose sibling", exact: true }).click();
	await expect(page.getByRole("region", { name: "Sibling notebook", exact: true })).toBeEmpty();
	await expect(page.getByText("Replacement mount", { exact: true })).toBeVisible();
});

test("measures and resizes narrow notebook roots", async ({ page }) => {
	await page.goto("/?scenario=width");
	await expect(page.getByLabel("Notebook width", { exact: true })).toHaveText("240.5");
	await page.getByRole("button", { name: "Resize notebook", exact: true }).click();
	await expect(page.getByLabel("Notebook width", { exact: true })).toHaveText("180.25");
	await page.getByRole("button", { name: "Dispose notebook", exact: true }).click();
	await expect(page.getByRole("region", { name: "Responsive notebook", exact: true })).toBeEmpty();
});
