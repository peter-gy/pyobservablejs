import marimo

__generated_with = "0.24.0"
app = marimo.App(width="medium")


@app.cell
def _():
    import marimo as mo
    import observablejs as obs

    return mo, obs


@app.cell
def _(mo):
    mo.md("""
    # Notebook integration
    """)


@app.cell
def _(obs):
    notebook = obs.Notebook(
        obs.ojs(
            """viewof left = {
      const input = document.createElement("input");
      input.type = "range";
      input.min = "0";
      input.max = "10";
      input.value = "2";
      input.setAttribute("aria-label", "Left");
      return input;
    }""",
            key="left",
        ),
        obs.ojs(
            """viewof right = {
      const input = document.createElement("input");
      input.type = "range";
      input.min = "0";
      input.max = "10";
      input.value = "3";
      input.setAttribute("aria-label", "Right");
      return input;
    }""",
            key="right",
        ),
        obs.js(
            """const total = typeof left === "number" ? left + right : "unwritable";
    const output = document.createElement("output");
    output.setAttribute("aria-label", "Browser total");
    output.textContent = String(total);
    display(output);""",
            key="sum",
        ),
        obs.ojs("prototypeValue = __proto__", key="prototype"),
        variables={"__proto__": 11},
    )
    full = notebook.view()
    focused = notebook.view("sum")
    uncaptured = notebook.view("sum", capture_state=False)
    return focused, full, notebook, uncaptured


@app.cell
def _(focused, full, mo, uncaptured):
    mo.vstack(
        [
            mo.Html(f'<section aria-label="Full view">{full.text}</section>'),
            mo.Html(f'<section aria-label="Focused view">{focused.text}</section>'),
            mo.Html(
                f'<section aria-label="Uncaptured view">{uncaptured.text}</section>'
            ),
        ]
    )


@app.cell
def _(mo, notebook):
    def disjoint(_):
        notebook.update_variables({"left": 7})
        notebook.update_variables({"right": 8})

    def adopt(_):
        notebook.update_variables({"left": 9})

    def unwritable(_):
        notebook.update_variables({"left": {"density": 21}})

    def restore(_):
        notebook.update_variables({"left": 7})

    def prototype(_):
        notebook.update_variables({"__proto__": 17})

    actions = [
        mo.ui.button(label="Apply disjoint updates", on_click=disjoint),
        mo.ui.button(label="Adopt left 9", on_click=adopt),
        mo.ui.button(label="Set unwritable left", on_click=unwritable),
        mo.ui.button(label="Restore left 7", on_click=restore),
        mo.ui.button(label="Update prototype", on_click=prototype),
    ]
    mo.hstack(actions, wrap=True)
    return (actions,)


@app.cell
def _(mo):
    create_view = mo.ui.run_button(label="Create a new view")
    mo.output.replace(create_view)
    return (create_view,)


@app.cell
def _(create_view, mo, notebook):
    fresh = notebook.view("sum") if create_view.value else None
    mo.Html(
        f'<section aria-label="Fresh view">{fresh.text}</section>'
    ) if fresh is not None else mo.md("New view not created")
    return (fresh,)


@app.cell
def _(focused, fresh, full, mo, uncaptured):
    _ = full.value
    _ = focused.value
    if fresh is not None:
        _ = fresh.value

    def state_text(view):
        state = view.state
        if state.input_revision is None:
            return "idle"
        if state.pending or state.settled_revision != state.input_revision:
            return "pending"
        if state.errors:
            return f"error: {state.errors}"
        result = state.result("sum")
        if result.status != "success":
            return f"error: {result.errors}"
        return f"ready total={result.values['total']}"

    _reports = [
        mo.Html(
            f'<output aria-label="Full Python state" data-revision="{full.state.input_revision}">{state_text(full)}</output>'
        ),
        mo.Html(
            f'<output aria-label="Focused Python state">{state_text(focused)}</output>'
        ),
        mo.Html(
            f'<output aria-label="Uncaptured Python state">{state_text(uncaptured)}</output>'
        ),
    ]
    if full.state.input_revision is not None and not full.state.pending:
        _prototype = full.state.result("prototype").values.get("prototypeValue")
        _reports.append(
            mo.Html(f'<output aria-label="Python prototype">{_prototype}</output>')
        )
    if fresh is not None:
        _reports.append(
            mo.Html(
                f'<output aria-label="Fresh Python state">{state_text(fresh)}</output>'
            )
        )
    mo.vstack(_reports)


@app.cell
def _(full, mo):
    def close(_):
        full.close()
        return True

    close_full = mo.ui.button(label="Close full view", on_click=close)
    mo.output.replace(close_full)
    return (close_full,)


@app.cell
def _(close_full, mo):
    mo.md("Full view closed" if close_full.value else "Full view open")


@app.cell
def _(mo, obs):
    imported = obs.Notebook.from_html(
        """<!doctype html><notebook theme="air">
    <script id="1" type="application/vnd.observable.javascript" name="rows">rows = FileAttachment("numbers.json").json()</script>
    <script id="2" type="application/vnd.observable.javascript" name="sum">sum = rows.reduce((total, value) => total + value, 0)</script>
    </notebook>""",
        files={"numbers.json": "data:application/json,%5B2%2C3%2C5%5D"},
    )
    imported_view = imported.view()
    mo.Html(f'<section aria-label="Imported view">{imported_view.text}</section>')
    return (imported_view,)


@app.cell
def _(imported_view, mo):
    _ = imported_view.value
    _state = imported_view.state
    _text = "pending"
    if (
        _state.input_revision is not None
        and not _state.pending
        and _state.settled_revision == _state.input_revision
        and not _state.errors
    ):
        _result = _state.result(imported_view.cells[1])
        _text = (
            f"ready sum={_result.values.get('sum')}"
            if _result.status == "success"
            else f"error: {_result.errors}"
        )
    mo.Html(f'<output aria-label="Imported Python state">{_text}</output>')


@app.cell
def _(mo, obs):
    table_notebook = obs.Notebook.from_observablehq_document(
        {
            "nodes": [
                {
                    "id": 1,
                    "mode": "js",
                    "value": """Inputs = ({table(rows) {
      const output = document.createElement("div");
      output.setAttribute("aria-label", rows.length ? rows[0].kind || "Table rows" : "Empty table columns");
      output.textContent = rows.length
        ? rows.map(row => row.label).join(",")
        : rows.schema.map(column => `${column.name}:${column.type}`).join(",");
      output.value = rows;
      return output;
    }})""",
                },
                {"id": 2, "mode": "js", "value": "scale = 3"},
                {
                    "id": 3,
                    "mode": "js",
                    "value": """source = [
      {label: "A", count: "1", day: "2030-01-01"},
      {label: "B", count: "4", day: "2030-01-02"},
      {label: "C", count: "8", day: "2030-01-03"},
      {label: "D", count: "6", day: "2030-01-04"},
      {label: "Skip", count: "10", day: "2030-01-05"}
    ]""",
                },
                {
                    "id": 4,
                    "mode": "table",
                    "name": "preview",
                    "data": {
                        "source": {
                            "type": "cell",
                            "name": "source",
                            "dialect": "array",
                        },
                        "operations": {
                            "from": {"table": "source"},
                            "select": {"columns": ["label", "count", "scaled", "day"]},
                            "types": [
                                {"name": "count", "type": "number"},
                                {"name": "day", "type": "date"},
                            ],
                            "names": [{"column": "count", "name": "units"}],
                            "derive": [
                                {"name": "scaled", "value": "row.units * scale"}
                            ],
                            "filter": [
                                {
                                    "type": "ne",
                                    "operands": [
                                        {"type": "column", "value": "label"},
                                        {"type": "primitive", "value": "Skip"},
                                    ],
                                },
                                {
                                    "type": "gte",
                                    "operands": [
                                        {"type": "column", "value": "day"},
                                        {"type": "date", "value": "2030-01-02"},
                                    ],
                                },
                                {
                                    "type": "v",
                                    "operands": [
                                        {"type": "column", "value": "count"},
                                        {"type": "primitive", "value": "number"},
                                    ],
                                },
                                {
                                    "type": "nn",
                                    "operands": [
                                        {"type": "column", "value": "label"},
                                    ],
                                },
                            ],
                            "sort": [{"column": "scaled", "direction": "desc"}],
                            "slice": {"from": 1, "to": 3},
                        },
                    },
                },
                {
                    "id": 5,
                    "mode": "js",
                    "value": """emptyRecords = Object.assign([], {schema: [
      {name: "amount", type: "number"}, {name: "extra", type: "string"}
    ]})""",
                },
                {
                    "id": 6,
                    "mode": "table",
                    "name": "emptyPreview",
                    "data": {
                        "source": {"type": "cell", "name": "emptyRecords"},
                        "operations": {
                            "select": {"columns": ["amount"]},
                            "names": [{"column": "amount", "name": "Value"}],
                        },
                    },
                },
                {
                    "id": 7,
                    "mode": "js",
                    "value": 'emptyColumns = Object.assign([], {columns: ["amount", "extra"]})',
                },
                {
                    "id": 8,
                    "mode": "table",
                    "name": "columnsPreview",
                    "data": {
                        "source": {"type": "cell", "name": "emptyColumns"},
                        "operations": {
                            "select": {"columns": ["amount"]},
                            "types": [{"name": "amount", "type": "number"}],
                            "names": [{"column": "amount", "name": "Value"}],
                        },
                    },
                },
                {
                    "id": 9,
                    "mode": "js",
                    "value": """FileAttachment = () => {
      const read = ({typed = false} = {}) => [{
        label: typed ? 1 : "001", kind: "File table rows"
      }];
      return {csv: read, tsv: read};
    }""",
                },
                {
                    "id": 10,
                    "mode": "table",
                    "name": "csvPreview",
                    "data": {
                        "source": {"type": "FileAttachment", "name": "codes.csv"},
                        "operations": {
                            "types": [{"name": "label", "type": "string"}],
                        },
                    },
                },
                {
                    "id": 11,
                    "mode": "table",
                    "name": "tsvPreview",
                    "data": {
                        "source": {"type": "FileAttachment", "name": "codes.tsv"},
                        "operations": {
                            "types": [{"name": "label", "type": "string"}],
                        },
                    },
                },
                {
                    "id": 12,
                    "mode": "table",
                    "name": "externalSource",
                    "data": {"source": {"type": "cell", "name": "_table12_source"}},
                },
                {
                    "id": 13,
                    "mode": "table",
                    "name": "externalQuery",
                    "data": {"source": {"type": "cell", "name": "_table13"}},
                },
            ]
        },
        variables={
            "_table12_source": [{"label": "outside", "kind": "External table rows"}],
            "_table13": [{"label": "another", "kind": "External table rows"}],
        },
    )
    table_view = table_notebook.view(
        "preview",
        "emptyPreview",
        "columnsPreview",
        "csvPreview",
        "tsvPreview",
        "externalSource",
        "externalQuery",
    )
    mo.Html(f'<section aria-label="Table import">{table_view.text}</section>')
    return table_notebook, table_view


@app.cell
def _(mo, table_notebook):
    table_scale = mo.ui.button(
        label="Change table scale",
        on_click=lambda _: table_notebook.update_variables({"scale": 2}),
    )
    mo.output.replace(table_scale)
    return (table_scale,)


@app.cell
def _(mo, table_view):
    import datetime
    import html
    import json

    _ = table_view.value
    _state = table_view.state
    _text = "pending"
    if _state.input_revision is not None and not _state.pending:
        _result = _state.result("preview")
        if _result.status == "success":
            _rows = _result.values["preview"]
            _text = json.dumps(
                [
                    {
                        "label": _row["label"],
                        "units": _row["units"],
                        "scaled": _row["scaled"],
                        "day": _row["day"].date().isoformat(),
                        "typed": isinstance(_row["day"], datetime.datetime)
                        and isinstance(_row["units"], int | float),
                    }
                    for _row in _rows
                ]
            )
        else:
            _text = f"error: {_result.errors}"
    mo.Html(f'<output aria-label="Table Python state">{html.escape(_text)}</output>')


@app.cell
def _(mo, obs):
    mo.stop(mo.query_params().get("classic") != "1")
    classic_notebook = obs.Notebook.from_observablehq_document(
        {
            "nodes": [
                {
                    "id": 10,
                    "mode": "js",
                    "value": 'controls = require("https://example.test/amd-controls.js")',
                },
                {
                    "id": 11,
                    "mode": "js",
                    "value": 'viewof amount = controls.range([0, 10], {value: 2, label: "Amount"})',
                },
                {
                    "id": 12,
                    "mode": "js",
                    "value": 'factor = require("https://example.test/amd-factor.js")',
                },
                {"id": 13, "mode": "js", "value": "total = amount * factor"},
            ]
        }
    )
    classic_first = classic_notebook.view()
    classic_second = classic_notebook.view()
    classic_third = classic_notebook.view()
    classic_fourth = classic_notebook.view()
    mo.vstack(
        [
            mo.Html(f'<section aria-label="Classic view {index}">{view.text}</section>')
            for index, view in enumerate(
                (classic_first, classic_second, classic_third, classic_fourth)
            )
        ]
    )
    return classic_first, classic_second, classic_third, classic_fourth


@app.cell
def _(classic_first, classic_second, classic_third, classic_fourth, mo):
    _ = classic_first.value
    _ = classic_second.value
    _ = classic_third.value
    _ = classic_fourth.value
    _reports = []
    for _index, _view in enumerate(
        (classic_first, classic_second, classic_third, classic_fourth)
    ):
        _state = _view.state
        _text = "pending"
        if _state.input_revision is not None and not _state.pending:
            _result = _state.result(_view.cells[3])
            _text = (
                str(_result.values["total"])
                if _result.status == "success"
                else f"error: {_result.errors}"
            )
        _reports.append(
            mo.Html(
                f'<output aria-label="Classic Python state {_index}">{_text}</output>'
            )
        )
    mo.vstack(_reports)


@app.cell
def _(mo, obs):
    mo.stop(mo.query_params().get("large") != "1")
    large_notebook = obs.Notebook(
        obs.ojs(
            'rows = Array.from({length: 31000}, (_, i) => Object.fromEntries(Array.from({length: 25}, (_, j) => ["field" + j, i + j])))',
            key="rows",
        ),
        obs.ojs("count = rows.length * scale", key="count"),
        variables={"scale": 2},
    )
    large_view = large_notebook.view()
    large_uncaptured = large_notebook.view("count", capture_state=False)
    mo.vstack(
        [
            large_view,
            mo.Html(
                f'<section aria-label="Large uncaptured view">{large_uncaptured.text}</section>'
            ),
        ]
    )
    return large_notebook, large_view, large_uncaptured


@app.cell
def _(large_notebook, mo):
    large_update = mo.ui.button(
        label="Scale large table",
        on_click=lambda _: large_notebook.update_variables({"scale": 3}),
    )
    mo.output.replace(large_update)


@app.cell
def _(large_view, large_uncaptured, mo):
    _ = large_view.value
    _state = large_view.state
    _text = "pending"
    if _state.input_revision is not None and not _state.pending:
        _rows = _state.result("rows").values.get("rows")
        _count = _state.result("count").values.get("count")
        _text = f"{_rows}: {_count}"
    mo.vstack(
        [
            mo.Html(f'<output aria-label="Large Python state">{_text}</output>'),
            mo.Html(
                f'<output aria-label="Large uncaptured state">{large_uncaptured.state.input_revision}</output>'
            ),
        ]
    )


@app.cell
def _(mo, obs):
    mo.stop(mo.query_params().get("sql") != "1")
    sql_notebook = obs.Notebook.from_observablehq_document(
        {
            "nodes": [
                {
                    "id": 1,
                    "mode": "js",
                    "value": """client = ({
  queryTag(strings, ...params) { return [strings.join("?"), params]; },
  queryStream(query, params, {signal}) {
    return {
      schema: [{name: "value", type: "number"}],
      async *readRows() {
        if (signal.aborted) return;
        yield [{value: params[0]}, {value: params[0] + 1}];
      }
    };
  }
})""",
                },
                {
                    "id": 2,
                    "mode": "sql",
                    "name": "rows",
                    "value": "SELECT ${offset + display + view} AS value",
                    "data": {
                        "source": {"type": "cell", "name": "client", "dialect": "sql"}
                    },
                },
                {
                    "id": 3,
                    "mode": "js",
                    "name": "total",
                    "value": "total = rows.map(row => row.value).reduce((a, b) => a + b, 0)",
                },
                {
                    "id": 4,
                    "mode": "sql",
                    "name": "hiddenRows",
                    "value": "SELECT ${offset + 10} AS value",
                    "data": {
                        "source": {"type": "cell", "name": "client", "dialect": "sql"},
                        "display": {"mode": "none"},
                    },
                },
                {
                    "id": 5,
                    "mode": "sql",
                    "value": "SELECT ${offset + 20} AS value",
                    "data": {
                        "source": {"type": "cell", "name": "client", "dialect": "sql"}
                    },
                },
                {"id": 6, "mode": "js", "value": "display = 17"},
                {"id": 7, "mode": "js", "value": "view = 23"},
            ]
        },
        variables={"offset": 2},
    )
    sql_view = sql_notebook.view()
    mo.Html(f'<section aria-label="SQL view">{sql_view.text}</section>')
    return sql_notebook, sql_view


@app.cell
def _(mo, sql_notebook):
    sql_update = mo.ui.button(
        label="Change SQL parameter",
        on_click=lambda _: sql_notebook.update_variables({"offset": 4}),
    )
    mo.output.replace(sql_update)


@app.cell
def _(mo, sql_view):
    _ = sql_view.value
    _state = sql_view.state
    _text = "pending"
    if _state.input_revision is not None and not _state.pending:
        _total = _state.result("total").values.get("total")
        _hidden = _state.result("hiddenRows").values.get("hiddenRows")
        _anonymous = _state.result(sql_view.cells[4]).status
        _first = _hidden[0]["value"] if _hidden else None
        _text = f"total={_total} hidden={_first} anonymous={_anonymous}"
    mo.Html(f'<output aria-label="SQL Python state">{_text}</output>')


@app.cell
def _(mo, obs):
    mo.stop(mo.query_params().get("data") != "1")
    data_notebook = obs.Notebook(
        obs.ojs(
            'rows = [{label: "A", value: scale}, {label: "B", value: 2 * scale}, {label: "C", value: 3 * scale}]',
            key="rows",
            display=False,
        ),
        obs.ojs("total = rows.reduce((sum, row) => sum + row.value, 0)", key="total"),
        obs.ojs("waiting = new Promise(() => {})", key="waiting", display=False),
        obs.ojs(
            'unused = { throw new Error("Unselected cell evaluated"); }', key="unused"
        ),
        obs.ojs('payload = FileAttachment("payload.bin").arrayBuffer()', key="payload"),
        title="Data access",
        variables={"scale": 2},
        files={
            "payload.bin": {
                "url": "data:application/octet-stream;base64,AP9hYmM=",
                "mimeType": "application/octet-stream",
                "size": 5,
            }
        },
    )
    data_view = data_notebook.view("total", "waiting", capture_state=False)
    import asyncio

    _initial: dict[str, object] = {"text": "pending"}
    get_data_result, _set_data_result = mo.state(_initial)

    async def _read_initial():
        try:
            _rows = await data_view.read(data_notebook.cell("rows"), format="rows")
            _inspection = data_view.inspection
            if _inspection is None:
                raise ValueError("Notebook inspection is unavailable")
            _row_data = _rows.data
            if not isinstance(_row_data, tuple):
                raise TypeError("Rows read must return detached rows")
            _datasets = data_view.datasets
            _dataset = next(item for item in _datasets if item.name == "rows")
            _read = await data_view.read(_dataset, columns=["value"], offset=1, limit=2)
            _arrow = _read.to_arrow()
            _sum = sum(_arrow.column("value").to_pylist())
            _bytes = await data_view.read_attachment("payload.bin")
            _timed_out = False
            try:
                await data_view.read("waiting", format="json", timeout=0.05)
            except TimeoutError:
                _timed_out = True
            _scalar = await data_view.read("total", format="json")
            _text = (
                f"cells={len(_inspection.cells)} hidden={_inspection.cells[0].hidden} "
                f"rows={len(_row_data)} source={_dataset.schema_source} "
                f"arrow={_arrow.num_rows} sum={_sum:g} "
                f"total={_scalar.data} bytes={_bytes.hex()} timeout={_timed_out} "
                f"capture={data_view.state.input_revision}"
            )
            _set_data_result({"text": _text, "dataset": _dataset})
        except (
            RuntimeError,
            ValueError,
            TypeError,
            TimeoutError,
            ImportError,
        ) as error:
            _set_data_result({"text": f"error: {error}"})

    get_updated_data, _set_updated_data = mo.state("pending")

    async def read_updated():
        try:
            _dataset = get_data_result().get("dataset")
            if not isinstance(_dataset, obs.types.DatasetInfo):
                raise TypeError("Dataset is unavailable")
            _stale = False
            try:
                await data_view.read(_dataset, format="rows")
            except obs.errors.ReadError as _error:
                _stale = "stale" in str(_error).lower()
            _datasets = data_view.datasets
            _current = next(item for item in _datasets if item.name == "rows")
            _result = await data_view.read(_current, columns=["value"], limit=2)
            _sum = sum(_result.to_arrow().column("value").to_pylist())
            _set_updated_data(f"stale={_stale} sum={_sum:g}")
        except (
            RuntimeError,
            ValueError,
            TypeError,
            TimeoutError,
            ImportError,
        ) as error:
            _set_updated_data(f"error: {error}")

    data_task = asyncio.create_task(_read_initial())
    mo.Html(f'<section aria-label="Data view">{data_view.text}</section>')
    return (
        data_notebook,
        data_view,
        asyncio,
        get_data_result,
        data_task,
        get_updated_data,
        read_updated,
    )


@app.cell
def _(get_data_result, mo):
    _text = get_data_result()["text"]
    mo.Html(f'<output aria-label="Data Python result">{_text}</output>')


@app.cell
def _(mo, data_notebook):
    data_update = mo.ui.button(
        label="Update data",
        on_click=lambda _: data_notebook.update_variables({"scale": 3}),
    )
    data_read_again = mo.ui.run_button(label="Read updated data")
    mo.hstack([data_update, data_read_again])
    return data_read_again, data_update


@app.cell
def _(asyncio, data_read_again, mo, read_updated):
    mo.stop(not data_read_again.value)
    updated_data_task = asyncio.create_task(read_updated())
    return (updated_data_task,)


@app.cell
def _(get_updated_data, mo):
    _text = get_updated_data()
    mo.Html(f'<output aria-label="Updated data result">{_text}</output>')


@app.cell
def _(data_view, mo):
    _ = data_view.value
    _inspection = data_view.inspection
    _text = (
        "pending"
        if _inspection is None
        else f"cells={len(_inspection.cells)} datasets={len(data_view.datasets)} capture={data_view.state.input_revision}"
    )
    mo.Html(f'<output aria-label="Data metadata">{_text}</output>')


if __name__ == "__main__":
    app.run()
