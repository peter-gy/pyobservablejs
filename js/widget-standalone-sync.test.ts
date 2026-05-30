// @vitest-environment jsdom

import type { RenderProps } from "@anywidget/types";
import { describe, expect, test } from "vitest";
import { SELECTORS } from "./widget/dom-contract";
import type { WidgetModel } from "./widget/types";
import widget from "./widget";
import {
	createCellExportsMap,
	createHost,
	createModel,
	objectValuedSelectSource,
	renderChildrenThroughWidget,
	variableValue,
	waitFor,
} from "./widget-test-utils";
import {
	chooseOption,
	displayForPointDensity,
	flushStandaloneInvalidations,
	inputWithValue,
	mountPresetDisplayNotebook,
	onlyInput,
	onlySelect,
	presetPointDensity,
	standaloneInspectorText,
	waitStep,
} from "./widget-dom-test-utils";

describe("widget standalone value sync", () => {
	test("standalone object-valued view updates keep composed selects selected", async () => {
		const model = createModel({
			role: "notebook",
			spec: {
				cells: [
					{
						id: 1,
						mode: "ojs",
						value: objectValuedSelectSource,
					},
					{ id: 2, mode: "ojs", value: "presetsArray = [{pointDensity: 7}, {pointDensity: 21}]" },
					{ id: 3, mode: "ojs", value: "viewof presets = Select(presetsArray, {value: presetsArray[0]})" },
					{ id: 4, mode: "ojs", value: "pointDensity = presets.pointDensity" },
				],
			},
			attachments: {},
			_variables: {},
			options: {},
			_cell_widgets: ["anywidget:select", "anywidget:presets-array", "anywidget:presets", "anywidget:point-density"],
		});
		const selectModel = createModel({ role: "cell", name: "select", _values: {}, _value_names: [] });
		const presetsArrayModel = createModel({ role: "cell", name: "presetsArray", _values: {}, _value_names: [] });
		const presetsModel = createModel({ role: "cell", name: "presets", _values: {}, _value_names: [] });
		const pointDensityModel = createModel({ role: "cell", name: "pointDensity", _values: {}, _value_names: [] });
		const childModels = new Map([
			["anywidget:select", selectModel],
			["anywidget:presets-array", presetsArrayModel],
			["anywidget:presets", presetsModel],
			["anywidget:point-density", pointDensityModel],
		]);
		const childExports = createCellExportsMap(childModels);
		const childRenders = renderChildrenThroughWidget(childModels);
		const parentEl = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el: parentEl,
			signal: controller.signal,
			host: createHost(childModels, childExports, childRenders),
		} as unknown as RenderProps<WidgetModel>);

		const parentSelect = await waitFor(() => onlySelect(parentEl));
		await waitFor(() => (variableValue(pointDensityModel, "pointDensity") === 7 ? 7 : undefined));

		const standaloneEl = document.createElement("div");
		widget.render({
			model: presetsModel,
			el: standaloneEl,
			signal: controller.signal,
			host: createHost(new Map()),
		} as unknown as RenderProps<WidgetModel>);

		const standaloneSelect = await waitFor(() => {
			const error = standaloneEl.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			return onlySelect(standaloneEl);
		});

		standaloneSelect.selectedIndex = 1;
		standaloneSelect.dispatchEvent(new Event("input", { bubbles: true }));
		standaloneSelect.dispatchEvent(new Event("change", { bubbles: true }));

		await waitFor(() => (variableValue(pointDensityModel, "pointDensity") === 21 ? 21 : undefined));
		expect(parentSelect.selectedIndex).toBe(1);
		expect(parentSelect.closest("form")?.value).toEqual({ pointDensity: 21 });
		expect(standaloneSelect.selectedIndex).toBe(1);
		controller.abort();
	});

	test("parent view changes update mounted standalone display cells", async () => {
		const controller = new AbortController();
		const { parentEl, firstStandaloneEl, secondStandaloneEl, parentSelect, standaloneSelect, presetsModel } =
			await mountPresetDisplayNotebook(controller);

		await waitStep("initial presets value", () => presetPointDensity(presetsModel, 7));
		await waitStep("initial parent display", () => displayForPointDensity(parentEl, 7));
		await waitStep("initial first standalone display", () => displayForPointDensity(firstStandaloneEl, 7));
		await waitStep("initial second standalone display", () => displayForPointDensity(secondStandaloneEl, 7));

		chooseOption(parentSelect, 1);

		await waitStep("parent change model value", () => presetPointDensity(presetsModel, 21));
		await waitStep("standalone select follows parent", () =>
			standaloneSelect.selectedIndex === 1 ? standaloneSelect : undefined,
		);
		await waitStep("parent display follows parent select", () => displayForPointDensity(parentEl, 21));
		await waitStep("first standalone display follows parent select", () =>
			displayForPointDensity(firstStandaloneEl, 21),
		);
		await waitStep("second standalone display follows parent select", () =>
			displayForPointDensity(secondStandaloneEl, 21),
		);
		controller.abort();
	});

	test("standalone view changes update parent and sibling display cells", async () => {
		const controller = new AbortController();
		const { parentEl, firstStandaloneEl, secondStandaloneEl, parentSelect, standaloneSelect, presetsModel } =
			await mountPresetDisplayNotebook(controller);

		await waitStep("initial presets value", () => presetPointDensity(presetsModel, 7));
		chooseOption(standaloneSelect, 1);

		await waitStep("standalone change model value", () => presetPointDensity(presetsModel, 21));
		await waitStep("parent select follows standalone", () =>
			parentSelect.selectedIndex === 1 ? parentSelect : undefined,
		);
		await waitStep("parent display follows standalone select", () => displayForPointDensity(parentEl, 21));
		await waitStep("first standalone display follows standalone select", () =>
			displayForPointDensity(firstStandaloneEl, 21),
		);
		await waitStep("second standalone display follows standalone select", () =>
			displayForPointDensity(secondStandaloneEl, 21),
		);
		controller.abort();
	});

	test("independent standalone cells preserve visible state across unrelated sibling changes", async () => {
		const controller = new AbortController();
		try {
			const model = createModel({
				role: "notebook",
				spec: {
					cells: [
						{
							id: 1,
							mode: "ojs",
							value: `
independent = {
  const input = document.createElement("input");
  input.value = "initial";
  return input;
}`,
						},
						{ id: 2, mode: "ojs", value: "gain = 1" },
					],
				},
				attachments: {},
				_variables: {},
				options: {},
				_cell_widgets: ["anywidget:independent", "anywidget:gain"],
			});
			const independentModel = createModel({ role: "cell", name: "independent", _values: {}, _value_names: [] });
			const gainModel = createModel({ role: "cell", name: "gain", _values: {}, _value_names: [] });
			const childModels = new Map([
				["anywidget:independent", independentModel],
				["anywidget:gain", gainModel],
			]);
			const childExports = createCellExportsMap(childModels);
			const childRenders = renderChildrenThroughWidget(childModels);
			const parentEl = document.createElement("div");
			const standaloneEl = document.createElement("div");

			widget.render({
				model,
				el: parentEl,
				signal: controller.signal,
				host: createHost(childModels, childExports, childRenders),
			} as unknown as RenderProps<WidgetModel>);
			await waitFor(() => (variableValue(gainModel, "gain") === 1 ? 1 : undefined));
			widget.render({
				model: independentModel,
				el: standaloneEl,
				signal: controller.signal,
				host: createHost(new Map()),
			} as unknown as RenderProps<WidgetModel>);

			const input = await waitFor(() => {
				return inputWithValue(standaloneEl, "initial");
			});
			input.value = "user edit";
			gainModel.set("_values", { gain: 2 });
			await waitFor(() => (variableValue(model, "gain") === 2 ? 2 : undefined));
			await flushStandaloneInvalidations();

			expect(onlyInput(standaloneEl).value).toBe("user edit");
		} finally {
			controller.abort();
		}
	});

	test("standalone dependency resolution ignores malformed unrelated cells", async () => {
		const model = createModel({
			role: "notebook",
			spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "bad =" },
					{ id: 2, mode: "ojs", value: 'message = "ready"' },
					{ id: 3, mode: "ojs", value: "message" },
				],
			},
			attachments: {},
			_variables: {},
			options: {},
			_cell_widgets: ["anywidget:bad", "anywidget:message", "anywidget:display"],
		});
		const badModel = createModel({ role: "cell", name: "bad", _values: {}, _value_names: [] });
		const messageModel = createModel({ role: "cell", name: "message", _values: {}, _value_names: [] });
		const displayModel = createModel({ role: "cell", name: "display", _values: {}, _value_names: [] });
		const childModels = new Map([
			["anywidget:bad", badModel],
			["anywidget:message", messageModel],
			["anywidget:display", displayModel],
		]);
		const childExports = createCellExportsMap(childModels);
		const childRenders = renderChildrenThroughWidget(childModels);
		const parentEl = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el: parentEl,
			signal: controller.signal,
			host: createHost(childModels, childExports, childRenders),
		} as unknown as RenderProps<WidgetModel>);
		await waitFor(() => (variableValue(messageModel, "message") === "ready" ? "ready" : undefined));

		const standaloneEl = document.createElement("div");
		widget.render({
			model: displayModel,
			el: standaloneEl,
			signal: controller.signal,
			host: createHost(new Map()),
		} as unknown as RenderProps<WidgetModel>);

		await waitFor(() => {
			const error = standaloneEl.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			return standaloneInspectorText(standaloneEl, "ready");
		});
		controller.abort();
	});
});
