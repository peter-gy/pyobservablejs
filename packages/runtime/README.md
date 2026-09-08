# @pyobservablejs/runtime

Mount [Observable Notebook Kit](https://github.com/observablehq/notebook-kit)
HTML or a notebook specification into a browser element. Each mount evaluates
reactive cells, renders their output, and exposes native JavaScript results.

This private workspace package is consumed by the widget and TypeScript apps
in this repository. Its entry point resolves to TypeScript source. The workspace
uses [Vite](https://vite.dev/), a browser development server and bundler, to
process that source and its inline CSS imports.

```ts
import { mountNotebook } from "@pyobservablejs/runtime";

const element = document.body.appendChild(document.createElement("div"));
const notebook = mountNotebook(
	element,
	{
		cells: [{ id: 1, value: "const answer = multiply(7); display(answer);" }],
	},
	{
		variables: { multiply: (value: number) => value * 3 },
		onState(state) {
			if (!state.pending) console.log(state.results[0]?.values.answer);
		},
	},
);
```

The cell displays `21` and its captured `answer` is `21`. Mounting installs
notebook, inspector, theme, and source styles in the owning document or shadow
root. The browser executes notebook code with the page's permissions. Use
trusted source. Cell compilation requires a
[Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP),
the browser's resource and script permissions, that permits dynamic JavaScript
evaluation. Imports and standard-library loaders
can make network requests subject to the page's policy.

## Source and selection

`mountNotebook(element, source, options?)` accepts a `NotebookSpec` or Notebook
Kit HTML as `source`. It returns a `MountedNotebook` immediately while cells
evaluate asynchronously. `element` must be a browser `HTMLElement` with no
active mount.

`selection` contains zero-based cell indexes. Omit it to render every cell.
`selection: [1]` renders the second cell and evaluates its dependencies in
hidden containers. `selection: []` renders an empty selection. Indexes must be
unique and within the notebook. Results contain selected cells. The graph
contains selected cells and their dependency closure.

`keys` supplies labels by notebook index. Labels appear in graph metadata and
name captured display values for cells with no exported variables. Selection
continues to use indexes.

## Variables and controls

`variables` injects a name-to-value record, defaulting to `{}`. Values retain
native identities, including functions, maps, dates, promises, and DOM nodes.
Observable resolves promises when evaluating their dependents. Runtime builtin
names such as `FileAttachment` and `width` are reserved.

| Method                     | Behavior                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `updateVariables(patch)`   | Merges injected variables and updates live evaluation. Clears stored input values for patched names.           |
| `replaceVariables(values)` | Replaces the injected environment and rebuilds evaluation. Omitted names return to their authored definitions. |
| `setInputs(values)`        | Replaces stored named input values and applies them to registered `viewof` controls.                           |

`inputs`, defaulting to `{}`, initializes the stored input mapping. Stored values
apply when a control registers, including after variable replacement. Omitting a
name from `setInputs` clears its stored value and leaves the current control
unchanged. Values the control cannot represent may be coerced before event
dispatch is suppressed.

`onInput(name, value)` receives browser interactions with native values.
Programmatic input writes recompute dependents without calling `onInput`.
Variable writes take ownership of a name and clear its stored input value.
A variable value that a control cannot represent overrides the runtime value
until a representable write reconnects the control.

Source, selection, and graph structure remain fixed for a mount. Variable
replacement preserves the read-only graph in pending and settled snapshots.
Dispose and mount again to change the notebook definition or display options.

## Evaluation checkpoints

```ts
await notebook.ready({ signal: AbortSignal.timeout(10_000) });
```

`ready()` returns the settled `NotebookState` or rejects with `DiagnosticError`.
It requires `captureState: true`. `notebook.diagnostics` and the `onDiagnostics`
mount callback expose current errors independently of preview capture. Each
record includes origin, phase, operation, component, and captured stack, cause,
and cell source when available. Successful reevaluation clears the cell's errors.

## State

Read `notebook.state` or supply `onState(state)` to observe evaluation:

| Field             | Meaning                                                                    |
| ----------------- | -------------------------------------------------------------------------- |
| `inputRevision`   | Current evaluation wave, initially `null`.                                 |
| `settledRevision` | Latest wave with every selected result settled, initially `null`.          |
| `pending`         | Whether selected results are still evaluating.                             |
| `graph`           | Cell metadata and dependency edges, initially `null`.                      |
| `results[index]`  | Selected cell revision, `status`, named `values`, and structured `errors`. |
| `errors`          | Errors affecting the whole mount.                                          |

Unchanged cell results retain their identity across snapshots. Snapshot records
are immutable, while values inside them retain their native identities.

Cell status is `pending`, `success`, or `error`. Error phases are `analysis`,
`evaluation`, and `rendering`. The callback can run during the initial call to
`mountNotebook`, so read its argument before the returned handle is assigned.

Snapshot records, result mappings, error records, and graph collections are
read-only. Native values inside `results[index].values` retain their original
identities. The caller owns mutations to those values and must trigger the
corresponding variable update or control event to reevaluate dependents.

`captureState: false` keeps the initial state and skips state callbacks while
rendering and input callbacks continue.

## Display and attachments

| Option           | Default and behavior                                                                 |
| ---------------- | ------------------------------------------------------------------------------------ |
| `theme`          | Uses the source theme. Accepts a Notebook Kit theme or `{ light, dark }`.            |
| `showSource`     | `false`. Shows source panels for selected pinned cells.                              |
| `runtimeProfile` | `"notebook-kit"`. Use `"observable"` for the classic Observable standard library.    |
| `attachments`    | `{}`. Maps names to `{ url, mimeType?, lastModified?, size? }` for `FileAttachment`. |
| `baseUrl`        | The element's document base URI. Resolves relative attachment URLs.                  |
| `signal`         | Optional `AbortSignal` that disposes the mount when aborted.                         |

Notebook Kit supplies cell defaults, including mode-specific pinning. Set
`pinned` explicitly when constructing cells whose source visibility matters.
Notebook Kit SQL preserves the database client's native result, including columnar
[Apache Arrow](https://arrow.apache.org/) tables. The Observable profile evaluates
SQL cells as row arrays through the classic query implementation. Queries receive
cell invalidation and can stream results.

## Inspect source and read data

Use the built `/inspect` entry point for source analysis in Node:

```ts
import { inspectNotebook } from "@pyobservablejs/runtime/inspect";

const info = inspectNotebook({
	cells: [
		{ id: 1, mode: "ojs", value: 'rows = FileAttachment("rows.csv").csv()' },
		{ id: 2, mode: "ojs", value: "count = rows.length" },
	],
});
console.log(info.cells[0].files); // ["rows.csv"]
console.log(info.graph.edges); // [{from: 1, to: 2, variable: "rows"}]
```

Inspection parses and analyzes source without evaluating cells or fetching
files. Notebook specifications work in Node. HTML input needs a host-provided
`DOMParser`. The browser root entry point also exports `inspectNotebook`.

`NotebookInspection` contains the full source catalog: cells and their source,
symbolic dependencies, imports and bindings, attachment references, database
and secret references, and per-cell analysis errors. A computed dynamic import
has `source: null` and `resolved: null`. An attachment with a literal reference
and no supplied file record has `url: null`.

A mounted notebook exposes readonly `inspection` and `datasets` snapshots.
`inspection` covers the full definition. `datasets` lists recognized values
from evaluated cells, including hidden dependencies. It can be empty while
values are pending. Dataset descriptions include column types, row counts,
source cells, and revisions. `schemaSource` distinguishes native schemas from
inference over at most 100 rows. `onDatasets` receives changes to this inventory.

```ts
import { mountNotebook } from "@pyobservablejs/runtime";

const values = new Float32Array([1, 2, 3]);
const dataMount = mountNotebook(
	document.body.appendChild(document.createElement("div")),
	{ cells: [{ id: 1, mode: "ojs", value: "rows = values" }] },
	{ variables: { values }, captureState: false },
);

const native = await dataMount.read("rows");
console.log(native.data === values); // true

const sample = await dataMount.read("rows", {
	format: "arrow",
	columns: ["value"],
	offset: 1,
	limit: 2,
});
console.log(sample.dataset?.rowCount); // 2
dataMount.dispose();
```

`read(selector, options?)` waits for a value in the evaluated selection or its
dependency closure. A string selects a native variable name. `{cell: index}`
selects that cell's sole exposed value, or its anonymous result. Add `name`
when a cell has several outputs. Names reported in `runtimeOutputs`, including
native `viewof` controls, can also be read explicitly. `path` traverses own
data properties and array indexes. Accessor properties are rejected.

| Format   | Result                                                                        |
| -------- | ----------------------------------------------------------------------------- |
| `native` | Default. Preserves native identity when no projection or range is requested.  |
| `rows`   | Projected row objects.                                                        |
| `arrow`  | Apache Arrow IPC stream bytes as a `Uint8Array`.                              |
| `bytes`  | Raw bytes from an ArrayBuffer, typed array, or `{attachment: name}` selector. |

Arrow tables and typed numeric arrays retain their native column types.
Arrow encoding supports both Apache Arrow and Flechette tables produced by
Notebook Kit. The source value stays in the runtime. `columns`, `offset`
(default `0`), and `limit` (default the remaining rows) apply to dataset reads.
Byte reads accept the complete binary value.

Pass a returned dataset descriptor back to `read` to require its value revision.
`signal` cancels a read. Input changes cancel pending value reads, and disposal
or replacement cancels outstanding reads. A value changing during conversion
causes an error. Inspection and explicit reads remain available with
`captureState: false`, while `state` stays at its initial preview snapshot.

## Disposal and failures

`notebook.dispose()` stops evaluation, removes input listeners, unregisters
attachments, revokes owned object URLs, and clears the element. Repeated
disposal is safe. The element can then host another mount. Shared styles remain
installed for sibling mounts.

An already-aborted signal or a second live mount on the same element throws.
Preparation and runtime errors appear in the element and captured state. Variable and
input methods throw after disposal or when the mount has no active runtime.
Variable methods also reject reserved builtin names.

The [`/values` entry point](src/value-api.ts) exports native value predicates
and `sameValue` for adapters. The [standalone browser tests](../../apps/e2e/tests/runtime.spec.ts)
exercise mounting, native identity, input updates, styles, and disposal through
the [TypeScript consumer](../../apps/e2e/standalone/main.ts).
