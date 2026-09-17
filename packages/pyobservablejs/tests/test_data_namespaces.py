from __future__ import annotations

import asyncio
import sys
from collections.abc import Iterator

import observablejs as obs
import pytest
from helpers import Browser
from test_notebook_access import dataset, inspection, read_result


@pytest.fixture
def widget_only(monkeypatch: pytest.MonkeyPatch) -> Iterator[Browser]:
    monkeypatch.setitem(sys.modules, "deno", None)
    monkeypatch.setitem(sys.modules, "observablejs._execution", None)
    with obs.Notebook(
        obs.ojs("rows = [{amount: 7}]", key="rows"),
        obs.ojs("total = rows[0].amount", key="total"),
        files={"numbers.csv": "data:text/csv,amount%0A7%0A"},
    ) as notebook:
        browser = Browser(notebook.view("total", capture_state=False), monkeypatch)
        browser.ready(value=inspection())
        yield browser


def test_widget_names_graph_and_python_reads_need_no_deno(widget_only: Browser) -> None:
    async def run() -> None:
        names = asyncio.create_task(widget_only.view.data.names())
        request = await widget_only.message()
        assert request["params"]["operation"] == "inspect"
        widget_only.reply(request, inspection())
        assert await names == ("rows", "total")
        upstream = asyncio.create_task(widget_only.view.graph.upstream("total"))
        request = await widget_only.message()
        widget_only.reply(request, inspection())
        assert await upstream == (widget_only.view.notebook.cells["rows"],)
        reading = asyncio.create_task(widget_only.view.data["rows"].to_python(limit=2))
        request = await widget_only.message()
        assert request["params"]["options"] == {
            "format": "python",
            "offset": 0,
            "limit": 2,
        }
        widget_only.reply(request, read_result([{"amount": 7}], format="rows"))
        assert await reading == [{"amount": 7}]

    asyncio.run(run())


def test_malformed_public_data_read_fails_other_pending_reads(
    widget_only: Browser,
) -> None:
    async def run() -> None:
        reading = asyncio.create_task(widget_only.view.data["rows"].to_python())
        request = await widget_only.message()
        pending = asyncio.create_task(widget_only.view.data["total"].to_python())
        await widget_only.message()
        widget_only.reply(request, read_result("invalid", format="arrow"))
        for task in (reading, pending):
            with pytest.raises(obs.errors.ProtocolError, match="read response"):
                await task

    asyncio.run(run())


def test_widget_dataframes_and_discovered_references(widget_only: Browser) -> None:
    import pyarrow as pa

    table = pa.table({"amount": [7]})
    sink = pa.BufferOutputStream()
    with pa.ipc.new_stream(sink, table.schema) as writer:
        writer.write_table(table)
    ipc = sink.getvalue().to_pybytes()

    async def run() -> None:
        discovering = asyncio.create_task(widget_only.view.data.discover())
        request = await widget_only.message()
        widget_only.reply(
            request, {"datasets": [dataset()], "errors": [], "pending": False}
        )
        catalog = await discovering
        ref = catalog.datasets["rows"]
        assert ref.cell is widget_only.view.notebook.cells["rows"]
        frame = asyncio.create_task(ref.to_polars(columns=["amount"]))
        request = await widget_only.message()
        assert request["params"]["options"]["revision"] == dataset()["revision"]
        widget_only.reply(
            request,
            {
                "cell": 0,
                "name": "rows",
                "revision": 7,
                "format": "arrow",
                "binary": True,
            },
            buffers=(ipc,),
        )
        assert (await frame).to_dicts() == [{"amount": 7}]
        description = asyncio.create_task(ref.describe())
        request = await widget_only.message()
        widget_only.reply(
            request,
            {
                "kind": "object",
                "dataset": {
                    key: value
                    for key, value in dataset().items()
                    if key not in {"cell", "name", "revision"}
                },
            },
        )
        assert (await description).row_count == dataset()["rowCount"]

    asyncio.run(run())


def test_files_are_synchronous_and_have_optional_async_access(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(sys.modules, "deno", None)
    with obs.Notebook(
        files={
            "sales.csv": "data:text/csv,year,amount%0A2026,7%0A",
            "config.json": "data:application/json,%7B%22answer%22:42%7D",
            "download": "data:application/octet-stream,x%0A1%0A",
        }
    ) as notebook:
        assert tuple(notebook.files) == ("sales.csv", "config.json", "download")
        assert notebook.files["sales.csv"].to_polars().to_dicts() == [
            {"year": 2026, "amount": 7}
        ]
        assert notebook.files["sales.csv"].to_arrow().num_rows == 1
        assert notebook.files["sales.csv"].to_pandas().shape == (1, 2)
        assert notebook.files["config.json"].to_python() == {"answer": 42}
        with pytest.raises(ValueError, match="format="):
            notebook.files["download"].to_polars()
        assert notebook.files["download"].to_polars(format="csv").to_dicts() == [
            {"x": 1}
        ]
        assert asyncio.run(notebook.files.aio["config.json"].to_python()) == {
            "answer": 42
        }
        assert notebook._session is None


def test_widget_attachment_bytes_use_its_own_view(widget_only: Browser) -> None:
    async def run() -> None:
        reading = asyncio.create_task(
            widget_only.view.files["numbers.csv"].read_bytes()
        )
        request = await widget_only.message()
        assert request["params"]["selector"] == {"attachment": "numbers.csv"}
        widget_only.reply(
            request,
            {
                "cell": None,
                "name": "numbers.csv",
                "revision": 0,
                "format": "bytes",
                "binary": True,
            },
            buffers=(b"amount\n9\n",),
        )
        assert await reading == b"amount\n9\n"

    asyncio.run(run())


@pytest.mark.parametrize("encoding", ["gzip", "deflate"])
def test_file_reads_decode_http_content_encoding(
    encoding: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    import gzip
    import io
    import urllib.request
    import zlib

    payload = b'{"answer":42}'
    compressed = (
        gzip.compress(payload) if encoding == "gzip" else zlib.compress(payload)
    )

    class Response(io.BytesIO):
        def __init__(self) -> None:
            super().__init__(compressed)
            self.headers = {"Content-Encoding": encoding}

    monkeypatch.setattr(urllib.request, "urlopen", lambda *args, **kwargs: Response())
    monkeypatch.setitem(sys.modules, "deno", None)
    with obs.Notebook(
        files={"data.json": "https://example.test/data.json"}
    ) as notebook:
        assert notebook.files["data.json"].read_bytes() == payload
        assert notebook.files["data.json"].to_python() == {"answer": 42}


def test_file_frames_preserve_late_fields_nested_objects_and_empty_records() -> None:
    import base64
    import json

    records = [{"value": i} for i in range(101)] + [{"value": 101, "late": "retained"}]
    object_value = {"name": "076", "nodes": [{"id": 1}, {"id": 2}], "links": []}
    files = {
        name: "data:application/json;base64,"
        + base64.b64encode(json.dumps(value).encode()).decode()
        for name, value in {
            "rows.json": records,
            "object.json": object_value,
            "empty.json": [{}, {}],
        }.items()
    }
    with obs.Notebook(files=files) as notebook:
        for name, expected in (
            ("rows.json", {"value": 101, "late": "retained"}),
            ("object.json", object_value),
        ):
            reference = notebook.files[name]
            assert reference.to_arrow().to_pylist()[-1] == expected
            assert reference.to_polars().to_dicts()[-1] == expected
            assert reference.to_pandas().to_dict("records")[-1] == expected
        assert notebook.files["empty.json"].to_arrow().num_rows == 2
        assert notebook.files["empty.json"].to_polars().shape == (2, 0)
        assert notebook.files["empty.json"].to_pandas().shape == (2, 0)
        assert notebook.files["object.json"].to_python() == object_value


def test_csv_inference_checks_all_rows_and_preserves_na_text_and_nullable_ids() -> None:
    import base64

    text = "value,id\n" + "1,9007199254740993\n" * 101 + "NA,\n"
    with obs.Notebook(
        files={
            "data.csv": "data:text/csv;base64,"
            + base64.b64encode(text.encode()).decode()
        }
    ) as notebook:
        file = notebook.files["data.csv"]
        for rows in (
            file.to_arrow().to_pylist(),
            file.to_polars().to_dicts(),
            file.to_pandas().to_dict("records"),
        ):
            assert rows[0] == {"value": "1", "id": 9007199254740993}
            assert rows[-1] == {"value": "NA", "id": None}


def test_json_frames_promote_nested_numbers_without_coercing_text_or_large_integers() -> (
    None
):
    import base64
    import json

    with obs.Notebook(
        files={
            name: "data:application/json;base64,"
            + base64.b64encode(json.dumps(value).encode()).decode()
            for name, value in {
                "coordinates.json": [{"point": [1, 2.5]}],
                "mixed.json": [{"id": 11}, {"id": "unknown"}],
                "precision.json": [{"id": 9007199254740993}, {"id": 1.5}],
            }.items()
        }
    ) as notebook:
        point = notebook.files["coordinates.json"]
        assert point.to_polars().to_dicts() == [{"point": [1.0, 2.5]}]
        assert point.to_arrow().to_pylist() == [{"point": [1.0, 2.5]}]
        for name in ("mixed.json", "precision.json"):
            file = notebook.files[name]
            for convert in (file.to_arrow, file.to_polars, file.to_pandas):
                with pytest.raises(ValueError, match="Use to_python"):
                    convert()
        assert notebook.files["mixed.json"].to_python() == [
            {"id": 11},
            {"id": "unknown"},
        ]


def test_duplicate_csv_headers_fail_before_a_column_can_be_lost() -> None:
    with obs.Notebook(
        files={"duplicate.csv": "data:text/csv,name,name%0Afirst,second%0A"}
    ) as notebook:
        file = notebook.files["duplicate.csv"]
        assert file.read_bytes() == b"name,name\nfirst,second\n"
        for convert in (file.to_python, file.to_arrow, file.to_polars, file.to_pandas):
            with pytest.raises(ValueError, match="duplicate column names"):
                convert()


def test_csv_trailing_blank_lines_do_not_add_rows_or_modify_quoted_newlines() -> None:
    import base64

    payload = b'id,note\r\n1,"first\r\n\r\nsecond"\r\n\r\n'
    with obs.Notebook(
        files={"data.csv": "data:text/csv;base64," + base64.b64encode(payload).decode()}
    ) as notebook:
        file = notebook.files["data.csv"]
        expected = [{"id": 1, "note": "first\r\n\r\nsecond"}]
        assert file.to_polars().to_dicts() == expected
        assert file.to_arrow().to_pylist() == expected
        assert file.to_pandas().to_dict("records") == expected


def test_nested_arrow_lists_remain_readable_in_pandas() -> None:
    import base64
    import json

    value = {"events": [{"DataPoints": [[{}, {"ExtraText": None}]]}]}
    with obs.Notebook(
        files={
            "data.json": "data:application/json;base64,"
            + base64.b64encode(json.dumps(value).encode()).decode()
        }
    ) as notebook:
        file = notebook.files["data.json"]
        assert file.to_pandas().to_dict("records") == file.to_arrow().to_pylist()


@pytest.mark.parametrize("payload", [b"", b"\r\n\r\n", b"id,value\r1,kept\r"])
def test_empty_csv_and_cr_line_endings_have_consistent_row_counts(
    payload: bytes,
) -> None:
    import base64

    with obs.Notebook(
        files={"data.csv": "data:text/csv;base64," + base64.b64encode(payload).decode()}
    ) as notebook:
        file = notebook.files["data.csv"]
        expected = 1 if payload.startswith(b"id") else 0
        records = file.to_python()
        assert isinstance(records, list)
        assert len(records) == expected
        assert file.to_arrow().num_rows == expected
        assert file.to_polars().height == expected
        assert len(file.to_pandas()) == expected


def test_csv_quoted_headers_have_the_same_names_in_every_format() -> None:
    import base64

    payload = b'"label ""quoted"", with comma",value\r\nx,7\r\n'
    with obs.Notebook(
        files={"data.csv": "data:text/csv;base64," + base64.b64encode(payload).decode()}
    ) as notebook:
        file = notebook.files["data.csv"]
        expected = [{'label "quoted", with comma': "x", "value": 7}]
        assert file.to_arrow().to_pylist() == expected
        assert file.to_polars().to_dicts() == expected
        assert file.to_pandas().to_dict("records") == expected


def test_geographic_json_files_use_json_conversion() -> None:
    with obs.Notebook(
        files={
            "shape.geojson": "data:application/geo+json,%7B%22type%22:%22Point%22,%22coordinates%22:[1,2]%7D",
            "shape.topojson": "data:application/json,%7B%22type%22:%22Point%22,%22coordinates%22:[1,2]%7D",
        }
    ) as notebook:
        expected = {"type": "Point", "coordinates": [1, 2]}
        for file in notebook.files.values():
            assert file.to_python() == expected
            assert file.to_polars().to_dicts() == [expected]
            assert file.to_arrow().to_pylist() == [expected]
            assert file.to_pandas().to_dict("records") == [expected]
