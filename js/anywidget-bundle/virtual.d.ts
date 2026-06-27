declare module "virtual:anywidget-bundle" {
	import type { InitializeProps, RenderProps } from "@anywidget/types";

	type AnyWidgetState = Record<string, unknown>;
	type AnyWidgetApp<ModelState extends AnyWidgetState> = {
		initialize?: (props: InitializeProps<ModelState> & { signal?: AbortSignal }) => void | Promise<void>;
		render: (props: RenderProps<ModelState> & { signal?: AbortSignal }) => void | Promise<void>;
	};

	export function loadApp<ModelState extends AnyWidgetState>(
		model: RenderProps<ModelState>["model"],
		signal: AbortSignal,
	): Promise<AnyWidgetApp<ModelState>>;
}
