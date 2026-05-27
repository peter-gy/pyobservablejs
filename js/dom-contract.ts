export const CLASS_NAMES = {
	widget: "pyobservablejs",
	notebook: "pyobservablejs-notebook",
	cell: "pyobservablejs-cell",
	error: "pyobservablejs-error",
	sourcePanel: "pyobservablejs-source-panel",
	sourceLabel: "pyobservablejs-source-label",
	source: "pyobservablejs-source",
	sourceLine: "pyobservablejs-source-line",
	sourceToken: "pyobservablejs-source-token",
} as const;

export const DATASET_KEYS = {
	composed: "pyobservablejsComposed",
	cellRef: "pyobservablejsCellRef",
	standaloneCell: "pyobservablejsStandaloneCell",
} as const;

export const DATA_ATTRIBUTES = {
	composed: "data-pyobservablejs-composed",
	cellRef: "data-pyobservablejs-cell-ref",
	standaloneCell: "data-pyobservablejs-standalone-cell",
} as const;

export const SELECTORS = {
	composedCell: `[${DATA_ATTRIBUTES.composed}='true']`,
	standaloneCell: `[${DATA_ATTRIBUTES.standaloneCell}='true']`,
	error: `.${CLASS_NAMES.error}`,
	sourcePanel: `.${CLASS_NAMES.sourcePanel}`,
	sourceLabel: `.${CLASS_NAMES.sourceLabel}`,
	source: `.${CLASS_NAMES.source}`,
	sourceHeader: ".pyobservablejs-source-header",
	sourceLine: `.${CLASS_NAMES.sourceLine}`,
	sourceToken: `.${CLASS_NAMES.sourceToken}`,
} as const;

export const CSS_VARIABLES = {
	sourceBackground: "--pyobservablejs-source-bg",
	sourceColor: "--pyobservablejs-source-color",
} as const;
