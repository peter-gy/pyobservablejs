import { expect, test } from "./fixture";

test("JupyterLab synchronizes Python variables and browser readback", async ({ page }, testInfo) => {
	await page.goto("http://127.0.0.1:27345/lab/tree/observablejs.ipynb");
	await expect(page.getByRole("tab", { name: "observablejs.ipynb", exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Python 3 (pyobservablejs) | Idle", exact: true })).toBeVisible();

	const runCell = async (source: string) => {
		await page.getByRole("textbox").filter({ hasText: source }).click();
		await page.getByRole("button", { name: /Run this cell and advance/ }).click();
	};

	await runCell("import observablejs as obs");
	const threshold = page.getByRole("slider", { name: "Threshold", exact: true });
	await expect(threshold).toHaveValue("0.5");
	await expect(page.getByText("Doubled threshold: 1", { exact: true })).toBeVisible();

	await runCell("notebook.update_variables");
	await expect(threshold).toHaveValue("0.8");
	await expect(page.getByText("Doubled threshold: 1.6", { exact: true })).toBeVisible();
	await runCell('print("Python patch readback:",');
	await expect(page.getByText("Python patch readback: 1.6", { exact: true })).toBeVisible();

	const bounds = await threshold.boundingBox();
	expect(bounds).not.toBeNull();
	await threshold.click({ position: { x: bounds!.width - 1, y: bounds!.height / 2 } });
	await expect(threshold).toHaveValue("1");
	await expect(page.getByText("Doubled threshold: 2", { exact: true })).toBeVisible();
	await runCell('print("Browser input readback:",');
	await expect(page.getByText("Browser input readback: 2", { exact: true })).toBeVisible();

	await threshold.scrollIntoViewIfNeeded();
	await page.screenshot({ path: testInfo.outputPath("jupyter-readback.png"), fullPage: true });

	await runCell("notebook.close()");
	await expect(page.getByText("Notebook session closed", { exact: true })).toBeVisible();
	await expect(threshold).toHaveCount(0);
	await page.getByRole("menuitem", { name: "Kernel", exact: true }).click();
	await page.getByRole("menuitem", { name: /Shut Down Kernel/ }).click();
	await expect(page.getByRole("button", { name: "No Kernel", exact: true })).toBeVisible();
});

test("JupyterLab reads Arrow and attachments independently of preview capture", async ({ page }) => {
	await page.goto("http://127.0.0.1:27345/lab/tree/data.ipynb");
	await expect(page.getByRole("tab", { name: "data.ipynb", exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Python 3 (pyobservablejs) | Idle", exact: true })).toBeVisible();
	await page.getByRole("textbox").filter({ hasText: "import observablejs as obs" }).click();
	await page.getByRole("button", { name: /Run this cell and advance/ }).click();
	await expect(page.locator(".pyobservablejs-notebook")).toBeVisible();
	await page.getByRole("textbox").filter({ hasText: "export = await data_view.read" }).click();
	await page.getByRole("button", { name: /Run this cell and advance/ }).click();
	const output = page.locator(".jp-OutputArea-output");
	await expect(output.filter({ hasText: "Data Arrow: rows=1 value=2" })).toBeVisible();
	await expect(output.filter({ hasText: "Data catalog: cells=2 datasets=1" })).toBeVisible();
	await expect(output.filter({ hasText: "Data bytes: [1, 2, 3]" })).toBeVisible();
	await expect(output.filter({ hasText: "Data preview: None" })).toBeVisible();
	await page.getByRole("textbox").filter({ hasText: "data_notebook.close()" }).click();
	await page.getByRole("button", { name: /Run this cell and advance/ }).click();
	await expect(page.getByText("Data session closed", { exact: true })).toBeVisible();
	await page.getByRole("menuitem", { name: "Kernel", exact: true }).click();
	await page.getByRole("menuitem", { name: /Shut Down Kernel/ }).click();
	await expect(page.getByRole("button", { name: "No Kernel", exact: true })).toBeVisible();
});
