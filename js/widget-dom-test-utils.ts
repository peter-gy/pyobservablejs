import { SELECTORS } from "./widget/dom-contract";
import { waitFor } from "./widget-test-utils";

export async function waitStep<T>(label: string, read: () => T | undefined, timeoutMs?: number): Promise<T> {
	try {
		return await waitFor(read, timeoutMs);
	} catch (error) {
		throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function composedText(el: HTMLElement, value: string): HTMLElement | undefined {
	const cells = Array.from(el.querySelectorAll<HTMLElement>(SELECTORS.composedCell));
	if (cells.length === 0) return undefined;
	const matches = cells.filter((cell) => (cell.textContent?.trim() ?? "") === value);
	if (matches.length === 0) return undefined;
	if (matches.length > 1) throw new Error(`Expected one composed cell with ${value}, found ${matches.length}`);
	return matches[0]!;
}

export function composedInspectorText(el: HTMLElement, value: string): HTMLElement | undefined {
	const cells = Array.from(el.querySelectorAll<HTMLElement>(SELECTORS.composedCell));
	if (cells.length === 0) return undefined;
	const matches = cells.filter((cell) => {
		const text = cell.textContent?.trim() ?? "";
		return text === value || text === `"${value}"`;
	});
	if (matches.length === 0) return undefined;
	if (matches.length > 1) throw new Error(`Expected one composed cell with ${value}, found ${matches.length}`);
	return matches[0]!;
}

export function projectErrorText(el: HTMLElement): string | undefined {
	const errors = Array.from(el.querySelectorAll<HTMLElement>(SELECTORS.error));
	if (errors.length === 0) return undefined;
	if (errors.length > 1) throw new Error(`Expected one error output, found ${errors.length}`);
	const text = errors[0]?.textContent?.trim() ?? "";
	return text || undefined;
}
