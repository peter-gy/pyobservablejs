import { expect, test as base } from "@playwright/test";

export const test = base.extend<{ browserDiagnostics: void }>({
	browserDiagnostics: [
		async ({ page }, use) => {
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			page.on("console", (message) => {
				if (message.type() === "error") errors.push(message.text());
			});
			await use();
			expect(errors, "Browser errors").toEqual([]);
		},
		{ auto: true },
	],
});

export { expect };
