import type { AnyModel, Initialize, Render } from "@anywidget/types";

export type AnyWidgetState = Record<string, unknown>;

export type AnyWidgetBundleApp<ModelState extends AnyWidgetState> = {
	initialize?: Initialize<ModelState>;
	render?: Render<ModelState>;
};

export type AnyWidgetBundleAppModule<ModelState extends AnyWidgetState> =
	| AnyWidgetBundleApp<ModelState>
	| (() => AnyWidgetBundleApp<ModelState> | Promise<AnyWidgetBundleApp<ModelState>>);

export type AnyWidgetBundleModel = Pick<AnyModel<AnyWidgetState>, "off" | "on" | "send">;
