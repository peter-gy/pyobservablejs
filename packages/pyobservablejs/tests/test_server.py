from __future__ import annotations

import asyncio
import datetime
import gc
import gzip
import math
import subprocess
import threading
import weakref
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Literal, cast

import observablejs as obs
import pytest

pytest.importorskip("deno")


@pytest.fixture
def server_processes(
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[list[subprocess.Popen[Any]]]:
    processes: list[subprocess.Popen[Any]] = []
    start = subprocess.Popen

    def track(*args: Any, **kwargs: Any) -> subprocess.Popen[Any]:
        process = start(*args, **kwargs)
        processes.append(process)
        return process

    monkeypatch.setattr(subprocess, "Popen", track)
    try:
        yield processes
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.wait()


def test_names_and_graph_do_not_execute_cells_or_open_widgets() -> None:
    with obs.Notebook(
        obs.js("const x = 3", key="input"),
        obs.js('throw new Error("must not execute"); const y = x * 2', key="result"),
    ) as notebook:
        assert notebook.data.names() == ("x", "y")
        assert notebook.graph.upstream("result") == (notebook.cells["input"],)
        assert notebook.graph.downstream("input") == (notebook.cells["result"],)
        assert notebook._session is None


def test_selected_reads_bindings_and_detached_python_values() -> None:
    with obs.Notebook(
        obs.js("const x = 3; const unused = 4", key="input"),
        obs.js("const rows = [{value: x * 2}]", key="result"),
        obs.js('throw new Error("outside selection")', key="other"),
    ) as notebook:
        reference = notebook.data["rows"]
        assert reference.cell is notebook.cells["result"]
        value = reference.to_python()
        assert value == [{"value": 6}]
        assert isinstance(value, list)
        assert isinstance(value[0], dict)
        cast(dict[str, object], value[0])["value"] = 99
        assert reference.to_python() == [{"value": 6}]
        notebook.update_variables({"x": 10})
        assert reference.to_python() == [{"value": 20}]
        notebook.reset_variables("x")
        assert reference.to_python() == [{"value": 6}]
        with notebook.with_variables(x=7) as bound:
            assert bound.data["rows"].to_python() == [{"value": 14}]
        assert reference.to_python() == [{"value": 6}]


@pytest.mark.parametrize("engine", ["deno", "chromium"])
def test_dataframes_preserve_nested_values_projection_and_binary_reads(
    engine: Literal["deno", "chromium"],
) -> None:
    import pandas as pd
    import polars as pl
    import pyarrow as pa

    with obs.Notebook(
        obs.js(
            """
const rows = [
 {a: input, b: "one", coords: [1,2], nested: {values: [[3,4]]}},
 {a: 2, b: "two", coords: [], nested: {values: []}}
];
const bytes = new Uint8Array([0, 128, 255]);
""",
            key="data",
        ),
        variables={"input": 1},
    ) as notebook:
        data = notebook.data.using(engine=engine)
        rows = data["rows"]
        expected = [
            {"a": 1, "b": "one", "coords": [1, 2], "nested": {"values": [[3, 4]]}},
            {"a": 2, "b": "two", "coords": [], "nested": {"values": []}},
        ]
        polars_frame, pandas_frame, arrow_table = (
            rows.to_polars(),
            rows.to_pandas(),
            rows.to_arrow(),
        )
        assert isinstance(polars_frame, pl.DataFrame)
        assert isinstance(pandas_frame, pd.DataFrame)
        assert isinstance(arrow_table, pa.Table)
        assert polars_frame.to_dicts() == expected
        assert pandas_frame.to_dict("records") == expected
        assert arrow_table.to_pylist() == expected
        assert rows.to_polars(columns=["a"], offset=1, limit=1).to_dicts() == [{"a": 2}]
        assert rows.to_python(columns=["a"], limit=1) == [{"a": 1}]
        description = rows.describe()
        assert description.row_count == 2
        assert description.schema_source == "sampled"
        assert data["bytes"].to_python() == b"\x00\x80\xff"
        notebook.update_variables({"input": 7})
        assert rows.to_python(columns=["a", "b"]) == [
            {"a": 7, "b": "one"},
            {"a": 2, "b": "two"},
        ]


def test_discovery_keeps_data_when_other_cells_fail_and_pins_revisions() -> None:
    with obs.Notebook(
        obs.js("const rows = [{a: x}]"),
        obs.js('throw new Error("bad chart")'),
        variables={"x": 1},
    ) as notebook:
        catalog = notebook.data.discover()
        assert catalog.errors[0].message == "bad chart"
        assert catalog.datasets.keys() == ("rows",)
        reference = catalog.datasets["rows"]
        assert reference.describe().schema == {"a": "number"}
        assert reference.to_python() == [{"a": 1}]
        notebook.update_variables({"x": 2})
        with pytest.raises(obs.errors.ObservableError, match="stale"):
            reference.to_python()
        assert notebook.data["rows"].to_python() == [{"a": 2}]


def test_static_attachment_lineage_and_file_loading() -> None:
    with obs.Notebook(
        obs.js('const raw = await FileAttachment("data.json").json()', key="load"),
        obs.js("const result = raw.items", key="result"),
        files={"data.json": "data:application/json,%7B%22items%22:[1,2]%7D"},
    ) as notebook:
        ref = notebook.data["result"]
        sources = ref.sources
        assert sources is not None
        assert [(s.kind, s.name, s.provenance) for s in sources] == [
            ("file", "data.json", "static")
        ]
        assert sources[0].url == notebook.files["data.json"].url
        assert ref.to_python() == [1, 2]
        assert notebook.files["data.json"].to_python() == {"items": [1, 2]}


def test_classic_imports_preserve_keys_and_python_binding_lifecycle() -> None:
    with (
        obs.Notebook(obs.ojs("x = 7")) as dependency,
        obs.Notebook.from_observablehq_document(
            {
                "id": "0123456789abcdef",
                "nodes": [
                    {
                        "id": 1,
                        "mode": "js",
                        "value": 'import {x} from "@test/dependency"',
                    },
                    {"id": 2, "mode": "js", "value": "answer = x * 6"},
                ],
            }
        ) as notebook,
    ):
        sources: list[str] = []

        def resolve(specifier: str) -> obs.Notebook:
            sources.append(specifier)
            return dependency

        assert notebook.data.names() == ("x", "answer")
        answer = notebook.cells["cell-2"]
        assert notebook.data["answer"].cell is answer
        assert notebook.graph.upstream(answer) == (notebook.cells["cell-1"],)
        reference = answer.data.using(resolve_notebook=resolve)["answer"]
        assert reference.to_python() == 42
        assert sources == ["@test/dependency"]
        assert notebook.variables == {}
        notebook.update_variables({"x": 3})
        assert reference.to_python() == 18
        assert notebook.variables == {"x": 3}
        notebook.reset_variables("x")
        assert reference.to_python() == 42
        assert notebook.variables == {}


def test_python_types_and_console_output() -> None:
    date = datetime.datetime(2026, 1, 2, tzinfo=datetime.timezone.utc)
    with obs.Notebook(
        obs.js(
            'console.log("keep stdout framed"); const result = {number, date, infinity, bytes: Array.from(bytes)}'
        ),
        variables={
            "number": 2**64,
            "date": date,
            "infinity": math.inf,
            "bytes": b"abc",
        },
    ) as notebook:
        assert notebook.data["result"].to_python() == {
            "number": 2**64,
            "date": date,
            "infinity": math.inf,
            "bytes": [97, 98, 99],
        }


def test_cell_local_reads_and_diagnostic_recovery() -> None:
    with obs.Notebook(
        obs.js(
            'if (x === 0) throw new Error("zero", {cause: new Error("inner")}); const result = 10 / x',
            key="calc",
        ),
        variables={"x": 0},
    ) as notebook:
        reference = notebook.cells["calc"].data["result"]
        with pytest.raises(obs.errors.NotebookError) as caught:
            reference.to_python()
        diagnostic = caught.value.diagnostics[0]
        assert diagnostic.cell and diagnostic.cell.key == "calc"
        assert diagnostic.cause and diagnostic.cause.message == "inner"
        notebook.update_variables({"x": 2})
        assert reference.to_python() == 5


def test_concurrent_reads_share_execution_across_namespaces_and_keep_bindings_isolated() -> (
    None
):
    async def run() -> None:
        with obs.Notebook(
            obs.js("const identity = crypto.randomUUID()", key="cell")
        ) as notebook:
            root, scoped = await asyncio.gather(
                notebook.data.aio["identity"].to_python(),
                notebook.cells["cell"].data.aio["identity"].to_python(),
            )
            assert scoped == root
            assert notebook.cells["cell"].data["identity"].to_python() == root
            assert notebook.data["identity"].to_python() == root
            assert notebook.cells["cell"].data.using()["identity"].to_python() != root

    asyncio.run(run())


def test_discovery_runtime_is_shared_with_direct_and_cell_scoped_reads() -> None:
    with obs.Notebook(
        obs.js("const rows = [{id: crypto.randomUUID()}]", key="rows"),
        obs.js("const other = [{value: 2}]", key="other"),
    ) as notebook:
        catalog = notebook.data.discover()
        rows = catalog.datasets["rows"].to_python()
        assert notebook.data["rows"].to_python() == rows
        assert notebook.cells["rows"].data["rows"].to_python() == rows
        assert asyncio.run(notebook.cells["rows"].data.aio["rows"].to_python()) == rows
        repeated = notebook.data.discover(*notebook.cells)
        assert repeated.datasets["rows"].to_python() == rows
        scoped = notebook.cells["rows"].data.discover()
        assert scoped.datasets.keys() == ("rows",)


def test_enclosing_selection_reuse_does_not_execute_unrelated_cells() -> None:
    with obs.Notebook(
        obs.js("const rows = [{id: crypto.randomUUID()}]", key="rows"),
        obs.js("const other = [{value: 2}]", key="other"),
        obs.js('throw new Error("must not execute")', key="unrelated"),
    ) as notebook:
        catalog = notebook.data.discover("rows", "other")
        assert not catalog.errors
        rows = catalog.datasets["rows"].to_python()
        assert notebook.data["rows"].to_python() == rows
        assert notebook.cells["rows"].data["rows"].to_python() == rows
        assert notebook._session is None


def test_python_owned_inputs_bypass_browser_controls() -> None:
    with obs.Notebook(
        obs.ojs('viewof input = { throw new Error("browser control") }'),
        obs.ojs("answer = input * 2"),
        variables={"input": 3},
    ) as notebook:
        assert notebook.data["answer"].to_python() == 6
        notebook.reset_variables("input")
        with pytest.raises(obs.errors.NotebookError, match="browser control"):
            notebook.data["answer"].to_python()


def test_async_headless_reads_and_discovery() -> None:
    async def run() -> None:
        with obs.Notebook(
            obs.js("const rows = [{value: 7}]"), obs.js('throw new Error("bad chart")')
        ) as notebook:
            data = notebook.data.aio
            assert await data.names() == ("rows",)
            assert await data["rows"].to_python() == [{"value": 7}]
            assert (await data["rows"].to_polars()).height == 1
            catalog = await data.discover()
            assert catalog.errors
            assert await catalog.datasets["rows"].to_python() == [{"value": 7}]

    asyncio.run(run())


def test_timeout_ends_noncooperative_execution() -> None:
    with (
        obs.Notebook(obs.js("while (true) {} const result = 1")) as notebook,
        pytest.raises(obs.errors.NotebookTimeoutError),
    ):
        notebook.data["result"].to_python(timeout=0.2)


def test_filesystem_access_stays_restricted() -> None:
    with (
        obs.Notebook(
            obs.js('const data = Deno.readTextFileSync("/etc/hosts")')
        ) as notebook,
        pytest.raises(obs.errors.NotebookError, match="Requires"),
    ):
        notebook.data["data"].to_python(timeout=5)


@pytest.mark.parametrize("engine", ["deno", "chromium"])
def test_remote_attachments_and_modules_work_by_default(
    engine: Literal["deno", "chromium"],
) -> None:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            module = self.path == "/module.js"
            payload = (
                b"export const factor = 2;"
                if module
                else gzip.compress(
                    b'[{"State":"CA","Value":7},{"State":"NY","Value":3}]'
                )
            )
            self.send_response(200)
            self.send_header(
                "Content-Type", "text/javascript" if module else "application/json"
            )
            if not module:
                self.send_header("Content-Encoding", "gzip")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    host = f"127.0.0.1:{server.server_port}"
    try:
        with obs.Notebook(
            obs.js(f"""
const data = await FileAttachment("source.json").json();
const {{factor}} = await import("http://{host}/module.js");
data.forEach((row, i) => data[i] = ({{state: row.State, total: +row.Value * factor}}));
"""),
            files={"source.json": f"http://{host}/source.json"},
        ) as notebook:
            data = (
                notebook.data
                if engine == "deno"
                else notebook.data.using(engine=engine)
            )
            expected = [{"state": "CA", "total": 14}, {"state": "NY", "total": 6}]
            assert data["data"].to_polars().to_dicts() == expected
            assert notebook.files["source.json"].to_python() == [
                {"State": "CA", "Value": 7},
                {"State": "NY", "Value": 3},
            ]
            assert (
                notebook.data.using(engine=engine, network=[host])["data"].to_python()
                == expected
            )
            with pytest.raises(obs.errors.NotebookError):
                notebook.data.using(engine=engine, network=False)["data"].to_python(
                    timeout=5
                )
    finally:
        server.shutdown()
        server.server_close()
        worker.join()


def test_chromium_canvas_rendering() -> None:
    with obs.Notebook(
        obs.js(
            'const canvas = document.createElement("canvas"); canvas.width=24; canvas.height=16; const ctx=canvas.getContext("2d"); ctx.fillStyle="red";ctx.fillRect(0,0,24,16);display(canvas);const pixels=Array.from(ctx.getImageData(0,0,1,1).data)',
            key="chart",
        )
    ) as notebook:
        assert notebook.data.using(engine="chromium")["pixels"].to_python() == [
            255,
            0,
            0,
            255,
        ]
        assert notebook.render.png("chart").startswith(b"\x89PNG")


def test_collecting_a_notebook_releases_its_child_processes(
    server_processes: list[subprocess.Popen[Any]],
) -> None:
    notebook = obs.Notebook(obs.js("const x=1"))
    assert notebook.data["x"].to_python() == 1
    reference = weakref.ref(notebook)
    del notebook
    gc.collect()
    assert reference() is None
    assert server_processes
    assert all(process.poll() is not None for process in server_processes)


def test_chromium_layout_notifications_do_not_fail_data_reads() -> None:
    with obs.Notebook(
        obs.js("""
const box = document.createElement("div");
box.style.width = "100px";
display(box);
let notifications = 0;
await new Promise(resolve => {
 const observer = new ResizeObserver(() => {
  if (++notifications === 2) { observer.disconnect(); resolve(); }
  else box.style.width = "101px";
 });
 observer.observe(box);
 invalidation.then(() => observer.disconnect());
});
const answer = 42;
""")
    ) as notebook:
        assert notebook.data.using(engine="chromium")["answer"].to_python() == 42


def test_discovery_retains_values_after_background_notebook_errors() -> None:
    with obs.Notebook(
        obs.js("""
const reported = new Promise(resolve => globalThis.addEventListener("unhandledrejection", () => resolve(), {once:true}));
Promise.reject(new Error("background chart failed"));
await reported;
const rows = [{value: 7}];
""")
    ) as notebook:
        catalog = notebook.data.discover(timeout=5)
        assert catalog.errors[0].origin == "notebook"
        assert catalog.errors[0].message == "background chart failed"
        assert catalog.datasets["rows"].to_python() == [{"value": 7}]


def test_empty_arrow_field_names_survive_polars_conversion() -> None:
    with obs.Notebook(obs.js('const rows = [{"":1, nested:{"":2}}]')) as notebook:
        assert notebook.data["rows"].to_polars().to_dicts() == [
            {"": 1, "nested": {"": 2}}
        ]


def test_missing_nested_list_and_struct_values_become_null() -> None:
    with obs.Notebook(
        obs.js("const rows = [{a:{list:[1,2], object:{value:3}}},{a:{}},{}]")
    ) as notebook:
        assert notebook.data["rows"].to_polars().to_dicts() == [
            {"a": {"list": [1, 2], "object": {"value": 3}}},
            {"a": {"list": None, "object": None}},
            {"a": None},
        ]


def test_cell_scope_is_preserved_for_sync_and_async_data_access() -> None:
    async def check(notebook: obs.Notebook) -> None:
        data = notebook.cells["selected"].data.aio
        reference = data["rows"]
        assert await reference.to_python() == [{"x": 1}, {"x": 2}]
        assert reference.cell is notebook.cells["selected"]
        assert (await reference.describe()).row_count == 2
        catalog = await data.discover()
        assert not catalog.errors
        assert catalog.datasets.keys() == ("rows",)
        assert await catalog.datasets["rows"].to_python() == [{"x": 1}, {"x": 2}]

    with obs.Notebook(
        obs.js("const rows = [{x: 1}, {x: 2}]", key="selected"),
        obs.js("const rows = [{x: 9}]", key="same-name"),
        obs.js('throw new Error("outside selected scope")', key="other"),
    ) as notebook:
        data = notebook.cells["selected"].data
        assert data["rows"].describe().row_count == 2
        assert not data.discover().errors
        asyncio.run(check(notebook))


def test_pandas_preserves_nullable_integers_and_distinguishes_nan_from_null() -> None:
    with obs.Notebook(
        obs.js(
            "const rows = [{id:9007199254740993n, value:null, nested:[{x:1}]}, {id:null, value:NaN, nested:null}]"
        )
    ) as notebook:
        rows = notebook.data["rows"]
        frame = rows.to_pandas()
        values = frame.to_dict("records")
        assert values[0] == {
            "id": 9007199254740993,
            "value": None,
            "nested": [{"x": 1}],
        }
        assert values[1]["id"] is None
        assert math.isnan(values[1]["value"])
        assert values[1]["nested"] is None


def test_async_discovered_references_expire_before_read_and_describe() -> None:
    async def run() -> None:
        with obs.Notebook(
            obs.js("const rows = [{value: x}]"), variables={"x": 1}
        ) as notebook:
            catalog = await notebook.data.aio.discover()
            rows = catalog.datasets["rows"]
            notebook.replace_variables({"x": 2})
            with pytest.raises(obs.errors.StaleViewError, match="expired"):
                await rows.to_python()
            with pytest.raises(obs.errors.StaleViewError, match="expired"):
                await rows.describe()
            assert await notebook.data.aio["rows"].to_python() == [{"value": 2}]

    asyncio.run(run())


def test_cancelled_noncooperative_read_stops_execution_and_can_recover(
    server_processes: list[subprocess.Popen[Any]],
) -> None:
    entered = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.send_response(204)
            self.end_headers()
            entered.set()

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()

    async def run() -> None:
        url = f"http://127.0.0.1:{server.server_port}/"
        source = f'const result = spin ? await fetch("{url}").then(() => {{ while (true) {{}} }}) : 1'
        with obs.Notebook(obs.js(source), variables={"spin": False}) as notebook:
            data = notebook.data.aio
            assert await data["result"].to_python() == 1
            notebook.update_variables({"spin": True})
            task = asyncio.create_task(data["result"].to_python())
            assert await asyncio.to_thread(entered.wait, 5)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert server_processes
            assert all(process.poll() is not None for process in server_processes)
            notebook.update_variables({"spin": False})
            assert await data["result"].to_python() == 1

    try:
        asyncio.run(run())
    finally:
        server.shutdown()
        worker.join()
        server.server_close()


@pytest.mark.parametrize(
    "prepared_analysis", [False, True], ids=["inspection", "evaluation"]
)
def test_cancelled_cold_acquisition_closes_engine_before_returning(
    monkeypatch: pytest.MonkeyPatch, prepared_analysis: bool
) -> None:
    from observablejs._server_process import ServerProcess

    entered = threading.Event()
    released = threading.Event()
    created: list[ServerProcess] = []
    original_wait = ServerProcess._wait_ready
    original_close = ServerProcess.close

    def pause_startup(process: ServerProcess) -> None:
        if not created:
            created.append(process)
            entered.set()
            assert released.wait(5)
        original_wait(process)

    def close(process: ServerProcess) -> None:
        original_close(process)
        released.set()

    async def run(notebook: obs.Notebook) -> None:
        task = asyncio.create_task(notebook.data.aio["result"].to_python())
        assert await asyncio.to_thread(entered.wait, 5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert created[0]._process.poll() is not None
        assert await notebook.data.aio["result"].to_python() == 42

    with obs.Notebook(obs.js("const result = 42")) as notebook:
        if prepared_analysis:
            assert notebook.data.names() == ("result",)
        monkeypatch.setattr(ServerProcess, "_wait_ready", pause_startup)
        monkeypatch.setattr(ServerProcess, "close", close)
        asyncio.run(run(notebook))
