import { expect, test } from "@playwright/test";

test("Jupyter raises detailed Python errors and checkpoints a corrected evaluation", async ({ page }, testInfo) => {
	const pageErrors: string[] = [];
	const consoleErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	await page.goto("http://127.0.0.1:27345/lab/tree/errors.ipynb");
	await expect(page.getByRole("button", { name: "Python 3 (pyobservablejs) | Idle", exact: true })).toBeVisible();
	const runCell = async (source: string | RegExp) => {
		await page.getByRole("textbox").filter({ hasText: source }).click();
		await page.getByRole("button", { name: /Run this cell and advance/ }).click();
	};
	await runCell("import observablejs as obs");
	await expect(page.locator(".pyobservablejs-notebook")).toBeVisible();
	await runCell(/^await error_view\.ready/);
	const outputs = page.locator(".jp-OutputArea-output");
	const authored = outputs.filter({ hasText: "NotebookError" });
	await expect(authored).toContainText("sample failed");
	await expect(authored).toContainText("input constraint");
	await expect(authored).toContainText("answer");
	await expect(authored).toContainText("RangeError");
	await runCell("error_notebook.update_variables");
	await expect(outputs.filter({ hasText: "Recovered: 42" })).toBeVisible();
	await runCell("render_notebook = obs.Notebook");
	await expect(page.getByText("Unable to inspect value: TypeError: inspection probe", { exact: true })).toBeVisible();
	await runCell("render_view.raise_for_errors()");
	const internal = outputs.filter({ hasText: "WidgetError" });
	await expect(internal).toContainText("inspection probe");
	await expect(internal).toContainText("preview detail");
	await expect(internal).toContainText("packages/runtime/src/cell-renderer.ts");
	await expect(internal).toContainText("ownKeys");
	await internal.scrollIntoViewIfNeeded();
	await page.screenshot({ path: testInfo.outputPath("python-widget-error.png"), fullPage: true });
	await runCell("error_notebook.close()");
	await expect(outputs.filter({ hasText: "Error sessions closed" })).toBeVisible();
	await page.getByRole("menuitem", { name: "Kernel", exact: true }).click();
	await page.getByRole("menuitem", { name: /Shut Down Kernel/ }).click();
	await expect(page.getByRole("button", { name: "No Kernel", exact: true })).toBeVisible();
	expect(pageErrors).toEqual([]);
	expect(
		consoleErrors.filter((message) => !message.includes("sample failed") && !message.includes("inspection probe")),
	).toEqual([]);
});

test("marimo raises widget errors from a reactive checkpoint with capture disabled", async ({ page }) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.goto("http://127.0.0.1:27347");
	await expect(page.getByText("Checkpoint healthy", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Trigger inspection failure", exact: true }).click();
	await expect(page.getByText("Checkpoint healthy", { exact: true })).toHaveCount(0);
	await expect(page.getByText(/WidgetError/, { exact: false }).first()).toBeVisible();
	await expect(
		page.getByText(/Component: packages\/runtime\/src\/cell-renderer.ts/, { exact: false }).first(),
	).toBeVisible();
	await page.getByRole("button", { name: "Recover inspection", exact: true }).click();
	await expect(page.getByText("Checkpoint healthy", { exact: true })).toBeVisible();
	expect(pageErrors).toEqual([]);
});
