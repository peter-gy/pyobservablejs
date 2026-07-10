import type { AnyModel, InitializeProps, Render } from "@anywidget/types";

export type AnyWidgetState = Record<string, unknown>;

type Cleanup = () => void | Promise<void>;

export type AnyWidgetBundleInitialize<ModelState extends AnyWidgetState> = (
	props: InitializeProps<ModelState>,
) => void | Cleanup | Promise<void | Cleanup>;

export type AnyWidgetBundleApp<ModelState extends AnyWidgetState> = {
	initialize?: AnyWidgetBundleInitialize<ModelState>;
	render?: Render<ModelState>;
};

export type AnyWidgetBundleAppModule<ModelState extends AnyWidgetState> =
	| AnyWidgetBundleApp<ModelState>
	| (() => AnyWidgetBundleApp<ModelState> | Promise<AnyWidgetBundleApp<ModelState>>);

export type AnyWidgetBundleModel = Pick<AnyModel<AnyWidgetState>, "off" | "on" | "send">;
