from __future__ import annotations

import asyncio
import dataclasses
from collections.abc import Iterator
from operator import setitem
from typing import Any, cast

import observablejs as obs
import pytest
import traitlets
from helpers import Browser, ObservableHQResponseInstaller


@pytest.fixture
def browser(monkeypatch: pytest.MonkeyPatch) -> Iterator[Browser]:
    notebook = obs.Notebook(
        obs.ojs("rows = [{amount: 7}]", key="rows"),
        obs.ojs("total = rows[0].amount", key="total"),
    )
    view = notebook.view("total", capture_state=False)
    yield Browser(view, monkeypatch)
    notebook.close()


def graph_cell(index: int, name: str) -> dict[str, Any]:
    return {
        "id": index + 1,
        "index": index,
        "key": name,
        "mode": "ojs",
        "defines": [name],
        "references": [] if index == 0 else ["rows"],
        "output": name,
        "outputs": [],
        "runtimeOutputs": [name],
        "autodisplay": True,
        "autoview": False,
        "automutable": False,
    }


def inspection() -> dict[str, Any]:
    cells = [graph_cell(0, "rows"), graph_cell(1, "total")]
    return {
        "title": "Research",
        "theme": {"light": "air", "dark": "near-midnight"},
        "runtimeProfile": "notebook-kit",
        "graph": {"cells": cells, "edges": [{"from": 1, "to": 2, "variable": "rows"}]},
        "cells": [
            {
                **cell,
                "source": "rows = [{amount: 7}]"
                if index == 0
                else "total = rows[0].amount",
                "pinned": False,
                "hidden": False,
                "files": ["numbers.csv"] if index == 0 else [],
                "databases": [],
                "secrets": [],
            }
            for index, cell in enumerate(cells)
        ],
        "attachments": [{"name": "numbers.csv", "url": None, "cells": [0]}],
        "imports": [
            {
                "cell": 0,
                "kind": "dynamic",
                "source": None,
                "resolved": None,
                "bindings": [],
                "injections": [],
            }
        ],
    }


def dataset() -> dict[str, Any]:
    return {
        "cell": 0,
        "name": "rows",
        "revision": 4,
        "kind": "arrow",
        "rowCount": 2,
        "columns": [{"name": "amount", "type": "Int64", "nullable": False}],
        "schemaSource": "native",
        "sampledRows": 0,
    }


def read_result(data: object, *, format: str = "json") -> dict[str, Any]:
    return {"cell": 0, "name": "rows", "revision": 4, "format": format, "data": data}


def test_cell_metadata_describes_prepared_source() -> None:
    notebook = obs.Notebook.from_html(
        '<notebook><script id="17" type="application/sql" '
        'data-pyobservablejs-key="query" database="var:db" output="rows" '
        "pinned hidden>select 1</script></notebook>"
    )
    cell = notebook.cell("query")
    assert (cell.id, cell.index, cell.mode, cell.source) == (17, 0, "sql", "select 1")
    assert cell.hidden and cell.pinned
    assert (cell.output, cell.database) == ("rows", "var:db")
    with pytest.raises(AttributeError):
        cell.__setattr__("source", "select 2")
    notebook.close()


def test_source_document_preserves_detached_provenance_and_authored_nodes() -> None:
    document: Any = {
        "id": "0123456789abcdef",
        "version": 3,
        "title": "Imported source",
        "creator": {"login": "example-author"},
        "nodes": [
            {
                "id": 37,
                "mode": "table",
                "name": "preview",
                "value": None,
                "data": {
                    "source": {"type": "cell", "name": "rows"},
                    "operations": {"select": {"columns": ["label"]}},
                },
            }
        ],
    }
    notebook = obs.Notebook.from_observablehq_document(document)
    source = cast(Any, notebook.source_document)
    document["creator"]["login"] = "changed"
    document["nodes"][0]["data"]["operations"]["select"]["columns"].append("extra")
    assert source["creator"]["login"] == "example-author"
    assert source["nodes"][0]["data"]["operations"]["select"]["columns"] == ("label",)
    assert source["nodes"][0]["mode"] == "table"
    assert notebook.cell("preview").id == 37
    assert notebook.cell("preview").mode == "ojs"
    assert notebook.cell("preview").source
    assert notebook.runtime_profile == "observable"
    with pytest.raises(TypeError):
        setitem(source["creator"], "login", "changed")
    with pytest.raises(AttributeError):
        notebook.__setattr__("source_document", None)
    copied = obs.Notebook.from_observablehq_document(source)
    assert copied.source_document == notebook.source_document
    assert copied.to_notebook_html() == notebook.to_notebook_html()
    assert copied.cell("preview").id == 37
    copied.close()
    notebook.close()


def test_source_fetch_retains_the_document_and_fetches_once(
    observablehq_response: ObservableHQResponseInstaller,
) -> None:
    document = {
        "title": "Remote",
        "version": 9,
        "nodes": [{"id": 71, "mode": "js", "value": "answer = 7"}],
    }
    requests = observablehq_response(document)
    notebook = obs.Notebook.from_observablehq("@example/notebook", timeout=1)
    assert len(requests) == 1
    assert cast(Any, notebook.source_document)["version"] == 9
    assert notebook.cells[0].id == 71
    assert notebook.runtime_profile == "observable"
    restored = obs.Notebook.from_html(notebook.to_notebook_html())
    assert restored.runtime_profile == "observable"
    assert restored.source_document is None
    authored = obs.Notebook(obs.ojs("value = 1"))
    assert authored.runtime_profile == "notebook-kit"
    assert authored.source_document is None
    restored.close()
    authored.close()
    notebook.close()


def test_metadata_traits_publish_full_immutable_inspection_independently_of_capture(
    browser: Browser,
) -> None:
    events = []
    browser.view.observe(events.append, names=["inspection", "datasets"])
    assert browser.view.inspection is None
    assert browser.view.datasets == ()
    raw = inspection()
    browser.ready(value=raw)
    result = browser.view.inspection
    assert result is not None
    assert [cell.key for cell in result.cells] == ["rows", "total"]
    assert result.cells[0].cell is browser.view.notebook.cell("rows")
    assert result.cells[1].cell is browser.view.notebook.cell("total")
    assert result.cells[0].source == "rows = [{amount: 7}]"
    assert result.graph.cell("total").references == ("rows",)
    assert result.graph.edges[0].variable == "rows"
    assert result.attachments[0].url is None
    assert result.attachments[0].cells == (browser.view.notebook.cell("rows"),)
    assert result.imports[0].source is None
    raw["cells"][0]["files"].append("later.csv")
    assert result.cells[0].files == ("numbers.csv",)
    with pytest.raises(TypeError):
        setitem(cast(Any, result.theme), "light", "dashboard")
    with pytest.raises(dataclasses.FrozenInstanceError):
        result.cells[0].__setattr__("source", "changed")
    browser.catalog([dataset()])
    assert [event["name"] for event in events] == ["inspection", "datasets"]
    assert browser.view.state.input_revision is None
    assert browser.messages.empty()
    with pytest.raises(traitlets.TraitError, match="read-only"):
        browser.view.__setattr__("datasets", ())


def test_metadata_catalogs_require_the_matching_runtime_generation(
    browser: Browser,
) -> None:
    browser.catalog([dataset()], generation="next")
    assert browser.view.datasets == ()
    browser.ready("next", value=inspection())
    assert len(browser.view.datasets) == 1
    observed_catalogs = []
    browser.view.observe(
        lambda _: observed_catalogs.append(browser.view.datasets), names="inspection"
    )
    browser.ready("third", value={**inspection(), "title": "Updated definition"})
    assert browser.view.datasets == ()
    assert observed_catalogs == [()]
    browser.catalog([dataset()], generation="next")
    assert browser.view.datasets == ()
    browser.catalog([dataset()], generation="third")
    assert browser.view.datasets[0].generation == "third"
    browser.view.set_trait("_inspection", {})
    assert browser.view.inspection is None and browser.view.datasets == ()


def test_metadata_replacements_are_decoded_from_reused_input_mappings(
    browser: Browser,
) -> None:
    inspection_payload = {"generation": "first", "value": inspection()}
    browser.view.set_state({"_inspection": inspection_payload})
    original = browser.view.inspection
    inspection_payload["value"] = {**inspection(), "title": "Replaced metadata"}
    browser.view.set_state({"_inspection": inspection_payload})
    assert browser.view.inspection is not None
    assert browser.view.inspection.title == "Replaced metadata"
    assert original is not None and original.title == "Research"
    catalog_payload = {"generation": "first", "values": [dataset()]}
    browser.view.set_state({"_datasets": catalog_payload})
    original_datasets = browser.view.datasets
    catalog_payload["values"] = [{**dataset(), "revision": 5, "rowCount": 3}]
    browser.view.set_state({"_datasets": catalog_payload})
    assert browser.view.datasets[0].revision == 5
    assert browser.view.datasets[0].row_count == 3
    assert original_datasets[0].revision == 4 and original_datasets[0].row_count == 2
    catalog_payload["values"] = [{**dataset(), "cell": 99}]
    with pytest.raises(ValueError, match="unknown cell"):
        browser.view.set_trait("_datasets", catalog_payload)
    assert browser.view.datasets[0].revision == 5


def test_dataset_descriptors_read_hidden_values_at_the_observed_revision(
    browser: Browser,
) -> None:
    async def run() -> None:
        browser.ready()
        browser.catalog([dataset()])
        (info,) = browser.view.datasets
        assert info.cell is browser.view.notebook.cell("rows")
        assert info.cell not in browser.view.cells
        assert info.columns == (obs.types.ColumnInfo("amount", "Int64", False),)
        assert info.row_count == 2 and info.generation == "first"
        reading = asyncio.create_task(
            browser.view.read(info, columns=["amount"], offset=1, limit=1)
        )
        request = await browser.message()
        assert request["params"] == {
            "selector": {"cell": 0, "name": "rows"},
            "options": {
                "format": "arrow",
                "offset": 1,
                "limit": 1,
                "columns": ["amount"],
                "revision": 4,
            },
        }
        browser.reply(
            request,
            {
                "cell": 0,
                "name": "rows",
                "revision": 4,
                "format": "arrow",
                "binary": True,
            },
            buffers=(b"IPC payload",),
        )
        result = await reading
        assert result.cell is info.cell and result.data == b"IPC payload"
        browser.ready("second")
        with pytest.raises(obs.errors.StaleViewError, match="expired"):
            await browser.view.read(info)

    asyncio.run(run())


def test_reads_keep_cells_variables_and_nested_paths_distinct(browser: Browser) -> None:
    async def run() -> None:
        browser.ready()
        reading = asyncio.create_task(
            browser.view.read(
                browser.view.notebook.cell("rows"),
                name="rows",
                path=(0, "amount"),
                format="json",
            )
        )
        request = await browser.message()
        assert request["params"]["selector"] == {
            "cell": 0,
            "name": "rows",
            "path": [0, "amount"],
        }
        browser.reply(request, read_result(7))
        assert (await reading).data == 7
        reading = asyncio.create_task(browser.view.read("rows", format="rows"))
        request = await browser.message()
        assert request["params"]["selector"] == {"name": "rows"}
        browser.reply(request, read_result([{"amount": 7}], format="rows"))
        result = await reading
        assert result.data == ({"amount": 7},)
        with pytest.raises(TypeError):
            setitem(cast(Any, result.data)[0], "amount", 9)

    asyncio.run(run())


@pytest.mark.parametrize("source", ["attachment", "value"])
def test_binary_reads_transfer_exact_bytes(browser: Browser, source: str) -> None:
    async def run() -> None:
        browser.ready()
        reading = asyncio.create_task(
            browser.view.read_attachment("asset.bin")
            if source == "attachment"
            else browser.view.read("rows", format="bytes")
        )
        request = await browser.message()
        expected = (
            {"selector": {"attachment": "asset.bin"}, "options": {"format": "bytes"}}
            if source == "attachment"
            else {
                "selector": {"name": "rows"},
                "options": {"format": "bytes", "offset": 0},
            }
        )
        assert request["params"] == expected
        browser.reply(
            request,
            {
                "cell": None if source == "attachment" else 0,
                "name": "asset.bin" if source == "attachment" else "rows",
                "revision": 0,
                "format": "bytes",
                "binary": True,
            },
            buffers=(bytes(range(256)),),
        )
        result = await reading
        assert (result if isinstance(result, bytes) else result.data) == bytes(
            range(256)
        )

    asyncio.run(run())


def test_concurrent_read_responses_are_correlated_and_browser_errors_propagate(
    browser: Browser,
) -> None:
    async def run() -> None:
        browser.ready()
        first = asyncio.create_task(browser.view.read("first", format="json"))
        second = asyncio.create_task(browser.view.read("second", format="json"))
        request_one, request_two = await browser.message(), await browser.message()
        browser.reply(request_two, read_result(2))
        browser.deliver(
            type="response",
            id=request_one["id"],
            generation="first",
            error={
                "name": "UnsupportedValueError",
                "message": "Choose a tabular value",
                "origin": "widget",
                "phase": "transport",
                "component": "packages/widget/src/requests.ts",
                "operation": "read value",
            },
        )
        assert (await second).data == 2
        with pytest.raises(
            obs.errors.ReadError,
            match="UnsupportedValueError: Choose a tabular value",
        ):
            await first

    asyncio.run(run())


def test_cancelled_and_timed_out_reads_cancel_browser_work(browser: Browser) -> None:
    async def run() -> None:
        browser.ready()
        cancelled = asyncio.create_task(browser.view.read("rows"))
        request = await browser.message()
        cancelled.cancel()
        with pytest.raises(asyncio.CancelledError):
            await cancelled
        cancel = await browser.message()
        assert (cancel["type"], cancel["id"], cancel["generation"]) == (
            "cancel",
            request["id"],
            "first",
        )
        timed = asyncio.create_task(browser.view.read("rows", timeout=0.01))
        request = await browser.message()
        with pytest.raises(TimeoutError):
            await timed
        assert (await browser.message())["id"] == request["id"]
        browser.reply(request, read_result("late"))
        fresh = asyncio.create_task(browser.view.read("rows", format="json"))
        request = await browser.message()
        browser.reply(request, read_result("current"))
        assert (await fresh).data == "current"

    asyncio.run(run())


def test_read_waits_for_initial_metadata_before_sending(browser: Browser) -> None:
    async def run() -> None:
        pending = asyncio.create_task(browser.view.read("rows", format="json"))
        asyncio.get_running_loop().call_soon(browser.ready)
        request = await browser.message()
        assert request["params"]["selector"] == {"name": "rows"}
        browser.reply(request, read_result(7))
        assert (await pending).data == 7

    asyncio.run(run())


def test_timeout_and_cancellation_before_metadata_keep_requests_local(
    browser: Browser,
) -> None:
    async def run() -> None:
        with pytest.raises(obs.errors.NotebookTimeoutError) as timed:
            await browser.view.read("rows", timeout=0.01)
        assert isinstance(timed.value, TimeoutError)
        pending = asyncio.create_task(browser.view.read("rows"))
        asyncio.get_running_loop().call_soon(pending.cancel)
        with pytest.raises(asyncio.CancelledError):
            await pending
        assert browser.messages.empty()

    asyncio.run(run())


def test_remount_fails_pending_reads_and_ignores_late_responses(
    browser: Browser,
) -> None:
    async def run() -> None:
        browser.ready()
        old = asyncio.create_task(browser.view.read("rows"))
        old_request = await browser.message()
        browser.ready("second")
        with pytest.raises(obs.errors.StaleViewError):
            await old
        current = asyncio.create_task(browser.view.read("rows", format="json"))
        request = await browser.message()
        browser.reply(old_request, read_result("obsolete"))
        browser.reply(request, read_result("current"))
        assert (await current).data == "current"

    asyncio.run(run())


def test_view_close_fails_readiness_waiters(
    browser: Browser,
) -> None:
    async def run() -> None:
        waiting = asyncio.create_task(browser.view.read("rows"))
        asyncio.get_running_loop().call_soon(browser.view.close)
        with pytest.raises(obs.errors.ViewClosedError):
            await waiting
        with pytest.raises(obs.errors.ViewClosedError):
            await browser.view.read("rows")

    asyncio.run(run())


def test_view_close_cancels_pending_browser_work(browser: Browser) -> None:
    async def run() -> None:
        browser.ready()
        pending = asyncio.create_task(browser.view.read("rows"))
        request = await browser.message()
        browser.view.close()
        with pytest.raises(obs.errors.ViewClosedError):
            await pending
        message = await browser.message()
        assert message["type"] == "cancel" and message["id"] == request["id"]
        browser.ready("second")
        with pytest.raises(obs.errors.ViewClosedError):
            await browser.view.read("rows")

    asyncio.run(run())


def test_unmounted_view_requires_a_new_metadata_generation(browser: Browser) -> None:
    async def run() -> None:
        browser.ready()
        pending = asyncio.create_task(browser.view.read("rows"))
        await browser.message()
        browser.view.set_trait("_inspection", {})
        with pytest.raises(obs.errors.ViewClosedError):
            await pending
        fresh = asyncio.create_task(browser.view.read("rows", format="json"))
        asyncio.get_running_loop().call_soon(browser.ready, "second", None)
        request = await browser.message()
        browser.reply(request, read_result(7))
        assert (await fresh).data == 7

    asyncio.run(run())


def test_binary_read_requires_a_response_buffer(browser: Browser) -> None:
    async def run() -> None:
        browser.ready()
        pending = asyncio.create_task(browser.view.read("rows"))
        request = await browser.message()
        browser.reply(
            request,
            {
                "cell": 0,
                "name": "rows",
                "revision": 4,
                "format": "arrow",
                "binary": True,
            },
        )
        with pytest.raises(obs.errors.ProtocolError, match="one buffer"):
            await pending

    asyncio.run(run())


def test_read_selectors_reject_foreign_cells_and_descriptors(
    browser: Browser, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def run() -> None:
        other_notebook = obs.Notebook(obs.ojs("other = 1", key="other"))
        try:
            with pytest.raises(ValueError, match="another Notebook"):
                await browser.view.read(other_notebook.cell("other"))
            other_view = browser.view.notebook.view()
            other = Browser(other_view, monkeypatch)
            other.ready()
            other.catalog([dataset()])
            (info,) = other.view.datasets
            with pytest.raises(ValueError, match="another NotebookView"):
                await browser.view.read(info)
            other_view.close()
        finally:
            other_notebook.close()

    asyncio.run(run())


def test_arrow_reads_decode_with_optional_pyarrow() -> None:
    arrow = pytest.importorskip("pyarrow")
    table = arrow.table({"amount": [7, None]})
    sink = arrow.BufferOutputStream()
    with arrow.ipc.new_stream(sink, table.schema) as writer:
        writer.write_table(table)
    result = obs.types.NotebookRead(
        None, "rows", 1, "arrow", sink.getvalue().to_pybytes()
    )
    assert result.to_arrow().equals(table)
    with pytest.raises(ValueError, match="Arrow read"):
        obs.types.NotebookRead(None, "value", 1, "json", 7).to_arrow()
