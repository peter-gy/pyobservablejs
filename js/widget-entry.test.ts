// @vitest-environment jsdom

import type { RenderProps } from "@anywidget/types";
import { describe, expect, test } from "vitest";
import type { WidgetModel } from "./widget/types";
import widget from "./widget";
import { createModel, hasSavedTrait } from "./widget-test-utils";

describe("widget entrypoint", () => {
	test("renders child cells as parent-owned outputs without requesting module source", () => {
		const model = createModel({ role: "cell", name: "answer", _values: {}, _value_names: [] });
		const el = document.createElement("div");

		widget.render({ model, el, signal: new AbortController().signal } as unknown as RenderProps<WidgetModel>);

		expect(el.textContent?.trim()).toBe("Error: NotebookCell renders only inside its parent Notebook display");
		expect(hasSavedTrait(model, "_esm_module_request")).toBe(false);
	});
});
