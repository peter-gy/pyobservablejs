import { expect, test } from "./fixture";

test.beforeEach(async ({ page }) => {
	await page.goto("/");
	await expect(page.getByLabel("Full Python state")).toHaveText("ready total=5");
	await expect(page.getByLabel("Focused Python state")).toHaveText("ready total=5");
	await expect(page.getByLabel("Imported Python state")).toHaveText("ready sum=10");
	await expect(
		page.getByRole("region", { name: "Uncaptured view", exact: true }).getByLabel("Browser total"),
	).toHaveText("5");
});

test("applies disjoint Python updates through both live views", async ({ page }) => {
	await page.getByRole("button", { name: "Apply disjoint updates", exact: true }).click();
	await expect(page.getByLabel("Full Python state")).toHaveText("ready total=15");
	await expect(page.getByLabel("Focused Python state")).toHaveText("ready total=15");
	const full = page.getByRole("region", { name: "Full view", exact: true });
	await expect(full.getByRole("slider", { name: "Left", exact: true })).toHaveValue("7");
	await expect(full.getByRole("slider", { name: "Right", exact: true })).toHaveValue("8");
});

test("shares browser interactions with existing and newly created views", async ({ page }) => {
	const full = page.getByRole("region", { name: "Full view", exact: true });
	const left = full.getByRole("slider", { name: "Left", exact: true });
	await left.press("End");
	await left.press("ArrowLeft");
	await expect(page.getByLabel("Full Python state")).toHaveText("ready total=12");
	await expect(page.getByLabel("Focused Python state")).toHaveText("ready total=12");
	await page.getByRole("button", { name: "Create a new view", exact: true }).click();
	await expect(page.getByLabel("Fresh Python state")).toHaveText("ready total=12");
	await expect(page.getByRole("region", { name: "Fresh view", exact: true }).getByLabel("Browser total")).toHaveText(
		"12",
	);
});

test("settles Python adoption of the current browser input", async ({ page }) => {
	const left = page
		.getByRole("region", { name: "Full view", exact: true })
		.getByRole("slider", { name: "Left", exact: true });
	await left.press("End");
	await left.press("ArrowLeft");
	await expect(page.getByLabel("Full Python state")).toHaveText("ready total=12");
	const revision = await page.getByLabel("Full Python state").getAttribute("data-revision");
	await page.getByRole("button", { name: "Adopt left 9", exact: true }).click();
	await expect(page.getByLabel("Full Python state")).not.toHaveAttribute("data-revision", revision!);
	await expect(page.getByLabel("Full Python state")).toHaveText("ready total=12");
	await expect(page.getByLabel("Focused Python state")).toHaveText("ready total=12");
});

test("restores browser interaction after an unwritable Python value", async ({ page }) => {
	await page.getByRole("button", { name: "Set unwritable left", exact: true }).click();
	await expect(page.getByLabel("Full Python state")).toHaveText("ready total=unwritable");
	await page.getByRole("button", { name: "Restore left 7", exact: true }).click();
	await expect(page.getByLabel("Full Python state")).toHaveText("ready total=10");
	const left = page
		.getByRole("region", { name: "Full view", exact: true })
		.getByRole("slider", { name: "Left", exact: true });
	await left.press("End");
	await left.press("ArrowLeft");
	await expect(page.getByLabel("Full Python state")).toHaveText("ready total=12");
	await expect(page.getByLabel("Focused Python state")).toHaveText("ready total=12");
});

test("renders reactive capture-disabled output while Python state stays idle", async ({ page }) => {
	await expect(page.getByLabel("Uncaptured Python state")).toHaveText("idle");
	await page.getByRole("button", { name: "Apply disjoint updates", exact: true }).click();
	await expect(page.getByLabel("Focused Python state")).toHaveText("ready total=15");
	await expect(
		page.getByRole("region", { name: "Uncaptured view", exact: true }).getByLabel("Browser total"),
	).toHaveText("15");
	await expect(page.getByLabel("Uncaptured Python state")).toHaveText("idle");
});

test("keeps sibling views live after closing one view", async ({ page }) => {
	await page.getByRole("button", { name: "Close full view", exact: true }).click();
	await expect(page.getByText("Full view closed", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Apply disjoint updates", exact: true }).click();
	await expect(page.getByLabel("Focused Python state")).toHaveText("ready total=15");
	await expect(page.getByLabel("Full Python state")).toHaveText("ready total=5");
	await expect(
		page.getByRole("region", { name: "Uncaptured view", exact: true }).getByLabel("Browser total"),
	).toHaveText("15");
});

test("preserves prototype-named variables across Python and browser transport", async ({ page }) => {
	await expect(page.getByLabel("Python prototype")).toHaveText("11");
	await page.getByRole("button", { name: "Update prototype", exact: true }).click();
	await expect(page.getByLabel("Python prototype")).toHaveText("17");
});

test("evaluates imported Notebook Kit HTML with an embedded file attachment", async ({ page }) => {
	await expect(page.getByLabel("Imported Python state")).toHaveText("ready sum=10");
	await expect(page.getByRole("region", { name: "Imported view", exact: true })).toContainText("10");
});

test("applies imported table operations and reevaluates derived dependencies", async ({ page }) => {
	const report = page.getByLabel("Table Python state");
	const readRows = async () => {
		const text = await report.textContent();
		return text === "pending" ? null : JSON.parse(text || "null");
	};
	const expected = [
		{ label: "D", units: 6, scaled: 18, day: "2030-01-04", typed: true },
		{ label: "B", units: 4, scaled: 12, day: "2030-01-02", typed: true },
	];
	await expect.poll(readRows).toEqual(expected);
	await expect(page.getByLabel("Table rows", { exact: true })).toHaveText("D,B");
	await page.getByRole("button", { name: "Change table scale", exact: true }).click();
	await expect.poll(readRows).toEqual([
		{ ...expected[0], scaled: 12 },
		{ ...expected[1], scaled: 8 },
	]);
});

test("projects and renames empty imported table schemas", async ({ page }) => {
	await expect(page.getByLabel("Empty table columns", { exact: true })).toHaveText(["Value:number", "Value:number"]);
});

test("preserves lexical values when imported file tables declare string columns", async ({ page }) => {
	await expect(page.getByLabel("File table rows", { exact: true })).toHaveText(["001", "001"]);
});

test("queries imported tables from Python-owned source names", async ({ page }) => {
	await expect(page.getByLabel("External table rows", { exact: true })).toHaveText(["outside", "another"]);
});
