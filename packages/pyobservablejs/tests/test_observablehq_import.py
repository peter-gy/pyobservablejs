from __future__ import annotations

import observablejs as obs
import pytest
from helpers import (
    DocumentTitle,
    ObservableHQResponseInstaller,
    ScriptTags,
    notebook_session,
)


@pytest.mark.parametrize(
    ("specifier", "api_url"),
    [
        (
            "https://observablehq.com/@d3/bar-chart",
            "https://api.observablehq.com/document/@d3/bar-chart",
        ),
        (
            "https://observablehq.com/@d3/bar-chart/2",
            "https://api.observablehq.com/document/@d3/bar-chart/2",
        ),
        (
            "https://observablehq.com/@d3/bar-chart@latest",
            "https://api.observablehq.com/document/@d3/bar-chart@latest",
        ),
        (
            "https://observablehq.com/d/1234567890abcdef",
            "https://api.observablehq.com/document/1234567890abcdef",
        ),
        (
            "https://api.observablehq.com/document/@d3/bar-chart",
            "https://api.observablehq.com/document/@d3/bar-chart",
        ),
        (
            "https://api.observablehq.com/document/1234567890abcdef",
            "https://api.observablehq.com/document/1234567890abcdef",
        ),
        ("@d3/bar-chart", "https://api.observablehq.com/document/@d3/bar-chart"),
        (
            "1234567890abcdef",
            "https://api.observablehq.com/document/1234567890abcdef",
        ),
    ],
)
def test_observablehq_specifier_resolution_matches_document_api(
    observablehq_response: ObservableHQResponseInstaller,
    specifier: str,
    api_url: str,
) -> None:
    requests = observablehq_response({"title": "Remote", "nodes": []})

    obs.Notebook.from_observablehq(specifier, timeout=1)

    assert requests == [(api_url, 1)]


def test_observablehq_rejects_non_observable_specifier() -> None:
    with pytest.raises(ValueError, match="Invalid ObservableHQ notebook specifier"):
        obs.Notebook.from_observablehq("https://example.com/@d3/bar-chart")


def test_notebook_from_observablehq_fetches_source_and_remote_attachments(
    observablehq_response: ObservableHQResponseInstaller,
    script_tags: ScriptTags,
    document_title: DocumentTitle,
) -> None:
    observablehq_response(
        {
            "title": "Remote",
            "nodes": [{"id": 1, "mode": "js", "value": "answer = 42"}],
            "files": [
                {
                    "name": "data.csv",
                    "download_url": "https://static.example/data.csv",
                }
            ],
        }
    )

    widget = obs.Notebook.from_observablehq(
        "https://observablehq.com/@d3/bar-chart",
        timeout=1,
        files={"local.csv": "https://example.test/local.csv"},
    )

    source = widget.to_notebook_html()
    scripts = script_tags(source)
    assert document_title(source) == "Remote"
    assert scripts[0]["attrs"].get("type") == "application/vnd.observable.javascript"
    assert scripts[0]["text"].strip() == "answer = 42"
    assert set(widget.attachments) == {"data.csv", "local.csv"}
    assert widget.attachments["data.csv"]["url"] == "https://static.example/data.csv"
    assert widget.attachments["local.csv"]["url"] == "https://example.test/local.csv"
    assert notebook_session(widget).get_state(["_options", "_runtime_profile"]) == {
        "_options": {"show_source": False},
        "_runtime_profile": "observable",
    }
    assert len(widget.cells) == 1


def test_observablehq_document_pins_imports_to_its_revision(
    script_tags: ScriptTags,
) -> None:
    notebook = obs.Notebook.from_observablehq_document(
        {
            "id": "0123456789abcdef",
            "version": 42,
            "title": "Imported modules",
            "nodes": [
                {
                    "id": 1,
                    "mode": "js",
                    "value": 'import {checkbox} from "@jashkenas/inputs"',
                },
                {
                    "id": 2,
                    "mode": "js",
                    "value": (
                        'import {footer} from "https://api.observablehq.com/'
                        '@tomlarkworthy/footer.js?v=4"'
                    ),
                },
            ],
        }
    )

    assert [
        script["text"].strip() for script in script_tags(notebook.to_notebook_html())
    ] == [
        'import {checkbox} from "https://api.observablehq.com/@jashkenas/'
        'inputs.js?v=4&resolutions=0123456789abcdef@42"',
        'import {footer} from "https://api.observablehq.com/@tomlarkworthy/'
        'footer.js?v=4&resolutions=0123456789abcdef@42"',
    ]


def test_observablehq_document_preserves_imports_without_a_valid_revision(
    script_tags: ScriptTags,
) -> None:
    source = 'import {checkbox} from "@jashkenas/inputs"'
    notebook = obs.Notebook.from_observablehq_document(
        {
            "title": "Imported module",
            "nodes": [{"id": 1, "mode": "js", "value": source}],
        }
    )

    [script] = script_tags(notebook.to_notebook_html())
    assert script["text"].strip() == source


def test_notebook_from_observablehq_converts_table_nodes(
    observablehq_response: ObservableHQResponseInstaller,
    script_tags: ScriptTags,
) -> None:
    observablehq_response(
        {
            "title": "Remote",
            "nodes": [
                {"id": 1, "mode": "js", "name": "rows", "value": "rows = []"},
                {
                    "id": 2,
                    "mode": "table",
                    "pinned": True,
                    "data": {"source": {"type": "cell", "name": "rows"}},
                },
            ],
        }
    )

    widget = obs.Notebook.from_observablehq("@d3/table-view", timeout=1)

    scripts = script_tags(widget.to_notebook_html())
    assert scripts[1]["attrs"].get("type") == "application/vnd.observable.javascript"
    assert "pinned" in scripts[1]["attrs"]
    assert scripts[1]["text"].strip() == "Inputs.table(await rows)"
    assert len(widget.cells) == 2


def test_notebook_from_observablehq_converts_named_file_table_nodes(
    observablehq_response: ObservableHQResponseInstaller,
    script_tags: ScriptTags,
) -> None:
    observablehq_response(
        {
            "title": "Remote",
            "nodes": [
                {
                    "id": 1,
                    "mode": "table",
                    "name": "worldbank",
                    "pinned": True,
                    "data": {
                        "source": {
                            "type": "FileAttachment",
                            "name": "wb_tidy.csv",
                        },
                        "display": {"mode": "none"},
                    },
                },
            ],
        }
    )

    widget = obs.Notebook.from_observablehq("@d3/table-view", timeout=1)

    scripts = script_tags(widget.to_notebook_html())
    assert scripts[0]["attrs"].get("type") == "application/vnd.observable.javascript"
    assert scripts[0]["attrs"].get("name") == "worldbank"
    assert "hidden" in scripts[0]["attrs"]
    assert scripts[0]["text"].strip() == (
        'viewof worldbank = Inputs.table(await FileAttachment("wb_tidy.csv").csv({typed: true}))'
    )
    assert widget.cells[0].name == "worldbank"


def test_notebook_from_observablehq_converts_empty_table_nodes(
    observablehq_response: ObservableHQResponseInstaller,
    script_tags: ScriptTags,
) -> None:
    observablehq_response(
        {
            "title": "Remote",
            "nodes": [
                {
                    "id": 1,
                    "mode": "table",
                    "data": {
                        "source": {"type": None, "name": None},
                        "operations": {"from": {"table": None}},
                    },
                },
            ],
        }
    )

    widget = obs.Notebook.from_observablehq("@d3/table-view", timeout=1)

    scripts = script_tags(widget.to_notebook_html())
    assert scripts[0]["text"].strip() == "Inputs.table(await [])"
    assert len(widget.cells) == 1


def test_notebook_from_observablehq_converts_chart_nodes_to_plot_auto(
    observablehq_response: ObservableHQResponseInstaller,
    script_tags: ScriptTags,
) -> None:
    observablehq_response(
        {
            "title": "Remote",
            "nodes": [
                {
                    "id": 1,
                    "mode": "chart",
                    "name": "revenueChart",
                    "pinned": True,
                    "data": {
                        "source": {"type": "cell", "name": "orders"},
                        "config": {
                            "x": {"type": "field", "value": "order_date"},
                            "y": {"type": "field", "value": "revenue"},
                            "fx": {"type": "undefined"},
                            "fy": {"type": "field", "value": "category"},
                            "mark": {"type": "constant", "value": "area"},
                            "size": {"type": "undefined"},
                            "color": {"type": "field", "value": "category"},
                            "options": {"marginLeft": 60},
                        },
                    },
                },
            ],
        }
    )

    widget = obs.Notebook.from_observablehq("@d3/chart-view", timeout=1)

    scripts = script_tags(widget.to_notebook_html())
    assert scripts[0]["attrs"].get("type") == "application/vnd.observable.javascript"
    assert scripts[0]["attrs"].get("name") == "revenueChart"
    assert scripts[0]["text"].strip() == (
        'revenueChart = Plot.auto(await orders, {"x": "order_date", "y": "revenue", '
        '"fy": "category", "color": "category", "mark": "area", "marginLeft": 60}).plot()'
    )
    assert widget.cells[0].name == "revenueChart"


def test_notebook_from_observablehq_preserves_chart_channel_options(
    observablehq_response: ObservableHQResponseInstaller,
    script_tags: ScriptTags,
) -> None:
    observablehq_response(
        {
            "title": "Remote",
            "nodes": [
                {
                    "id": 1,
                    "mode": "chart",
                    "pinned": True,
                    "data": {
                        "source": {"type": "cell", "name": "rows"},
                        "config": {
                            "x": {"type": "field", "value": "year"},
                            "y": {
                                "type": "field",
                                "value": "life",
                                "reduce": "mean",
                            },
                            "fx": {"type": "undefined"},
                            "fy": {"type": "undefined"},
                            "mark": {"type": "constant", "value": "bar"},
                            "size": {"type": "undefined"},
                            "color": {"type": "field", "value": "region"},
                            "options": {
                                "x": {"grid": True, "label": "Year"},
                                "color": {"legend": True},
                                "height": 300,
                            },
                        },
                    },
                },
            ],
        }
    )

    widget = obs.Notebook.from_observablehq("@d3/chart-view", timeout=1)

    scripts = script_tags(widget.to_notebook_html())
    assert scripts[0]["text"].strip() == (
        'Plot.auto(await rows, {"x": {"grid": true, "label": "Year", "value": "year"}, '
        '"y": {"value": "life", "reduce": "mean"}, "color": {"legend": true, '
        '"value": "region"}, "mark": "bar", "height": 300}).plot()'
    )


def test_notebook_from_observablehq_converts_empty_chart_nodes(
    observablehq_response: ObservableHQResponseInstaller,
    script_tags: ScriptTags,
) -> None:
    observablehq_response(
        {
            "title": "Remote",
            "nodes": [
                {
                    "id": 1,
                    "mode": "chart",
                    "data": {
                        "source": {"type": None, "name": None},
                        "config": {
                            "x": {"type": "undefined"},
                            "y": {"type": "undefined"},
                            "fx": {"type": "undefined"},
                            "fy": {"type": "undefined"},
                            "mark": {"type": "undefined"},
                            "size": {"type": "undefined"},
                            "color": {"type": "undefined"},
                            "options": {},
                        },
                    },
                },
            ],
        }
    )

    widget = obs.Notebook.from_observablehq("@d3/chart-view", timeout=1)

    scripts = script_tags(widget.to_notebook_html())
    assert scripts[0]["text"].strip() == "undefined"
    assert len(widget.cells) == 1


@pytest.mark.parametrize("mode", ["html", "md"])
def test_notebook_from_observablehq_converts_named_template_cells_to_outputs(
    observablehq_response: ObservableHQResponseInstaller,
    script_tags: ScriptTags,
    mode: str,
) -> None:
    observablehq_response(
        {
            "title": "Remote",
            "nodes": [
                {
                    "id": 1,
                    "mode": mode,
                    "name": "templateCell",
                    "value": "Rendered template",
                },
                {
                    "id": 2,
                    "mode": "js",
                    "value": "templateCell",
                },
            ],
        }
    )

    widget = obs.Notebook.from_observablehq("@d3/template-view", timeout=1)

    scripts = script_tags(widget.to_notebook_html())
    assert scripts[0]["attrs"].get("output") == "templateCell"
    assert scripts[1]["text"].strip() == "templateCell"


def test_notebook_from_observablehq_converts_duckdb_sql_nodes(
    observablehq_response: ObservableHQResponseInstaller,
    script_tags: ScriptTags,
) -> None:
    observablehq_response(
        {
            "title": "Remote",
            "nodes": [
                {
                    "id": 1,
                    "mode": "js",
                    "value": 'starDB = DuckDBClient.of({stars: FileAttachment("stars.parquet")})',
                },
                {
                    "id": 2,
                    "mode": "sql",
                    "name": "stars",
                    "pinned": True,
                    "value": "select * from stars",
                    "data": {
                        "source": {
                            "name": "starDB",
                            "type": "cell",
                            "dialect": "duckdb",
                        }
                    },
                },
            ],
        }
    )

    widget = obs.Notebook.from_observablehq("@d3/sql-view", timeout=1)

    scripts = script_tags(widget.to_notebook_html())
    assert scripts[1]["attrs"].get("type") == "application/sql"
    assert scripts[1]["attrs"].get("database") == "var:starDB"
    assert scripts[1]["attrs"].get("output") == "stars"
    assert scripts[1]["text"].strip() == "select * from stars"
    assert widget.cells[1].name == "stars"


def test_notebook_from_observablehq_converts_sql_database_nodes(
    observablehq_response: ObservableHQResponseInstaller,
    script_tags: ScriptTags,
) -> None:
    observablehq_response(
        {
            "title": "Remote",
            "nodes": [
                {
                    "id": 1,
                    "mode": "js",
                    "value": 'import {db} from "@observablehq/google-merchandise-sales-data"',
                },
                {
                    "id": 2,
                    "mode": "sql",
                    "name": "clothing",
                    "pinned": True,
                    "value": "select * from items where category = 'Apparel'",
                    "data": {
                        "source": {
                            "name": "db",
                            "type": "cell",
                            "dialect": "sql",
                        }
                    },
                },
            ],
        }
    )

    widget = obs.Notebook.from_observablehq("@d3/sql-view", timeout=1)

    scripts = script_tags(widget.to_notebook_html())
    assert scripts[1]["attrs"].get("type") == "application/sql"
    assert scripts[1]["attrs"].get("database") == "var:db"
    assert scripts[1]["attrs"].get("output") == "clothing"
    assert (
        scripts[1]["text"].strip() == "select * from items where category = 'Apparel'"
    )


def test_notebook_from_observablehq_uses_runtime_duckdb_client_for_of_calls(
    observablehq_response: ObservableHQResponseInstaller,
    script_tags: ScriptTags,
) -> None:
    observablehq_response(
        {
            "title": "Remote",
            "nodes": [
                {
                    "id": 1,
                    "mode": "js",
                    "value": 'import {DuckDBClient} from "@cmudig/duckdb"',
                },
                {
                    "id": 2,
                    "mode": "js",
                    "value": 'db = DuckDBClient.of([["papers", FileAttachment("papers.csv")]])',
                },
            ],
        }
    )

    widget = obs.Notebook.from_observablehq("@d3/duckdb-view", timeout=1)

    scripts = script_tags(widget.to_notebook_html())
    assert scripts[0]["attrs"].get("type") == "application/vnd.observable.javascript"
    assert "hidden" in scripts[0]["attrs"]
    assert scripts[0]["text"].strip() == "undefined"
    assert scripts[1]["text"].strip() == (
        'db = DuckDBClient.of([["papers", FileAttachment("papers.csv")]])'
    )


def test_notebook_from_observablehq_preserves_duckdb_import_for_constructor_calls(
    observablehq_response: ObservableHQResponseInstaller,
    script_tags: ScriptTags,
) -> None:
    observablehq_response(
        {
            "title": "Remote",
            "nodes": [
                {
                    "id": 1,
                    "mode": "js",
                    "value": 'import {DuckDBClient} from "@cmudig/duckdb"',
                },
                {
                    "id": 2,
                    "mode": "js",
                    "value": "db = new DuckDBClient()",
                },
                {
                    "id": 3,
                    "mode": "js",
                    "value": "db.describe()",
                },
            ],
        }
    )

    widget = obs.Notebook.from_observablehq("@d3/duckdb-view", timeout=1)

    scripts = script_tags(widget.to_notebook_html())
    assert scripts[0]["text"].strip() == ('import {DuckDBClient} from "@cmudig/duckdb"')


def test_notebook_from_observablehq_converts_array_sql_nodes(
    observablehq_response: ObservableHQResponseInstaller,
    script_tags: ScriptTags,
) -> None:
    observablehq_response(
        {
            "title": "Remote",
            "nodes": [
                {"id": 1, "mode": "js", "value": "rows = []"},
                {
                    "id": 2,
                    "mode": "sql",
                    "name": "summary",
                    "pinned": True,
                    "value": "select count(*) as n from rows",
                    "data": {
                        "source": {
                            "name": "rows",
                            "type": "cell",
                            "dialect": "array",
                        }
                    },
                },
            ],
        }
    )

    widget = obs.Notebook.from_observablehq("@d3/sql-view", timeout=1)

    scripts = script_tags(widget.to_notebook_html())
    assert scripts[1]["attrs"].get("type") == "application/vnd.observable.javascript"
    assert "hidden" in scripts[1]["attrs"]
    assert scripts[1]["attrs"].get("output") == "rowsDB"
    assert scripts[1]["text"].strip() == ('rowsDB = DuckDBClient.of({["rows"]: rows})')
    assert scripts[2]["attrs"].get("type") == "application/sql"
    assert scripts[2]["attrs"].get("database") == "var:rowsDB"
    assert scripts[2]["attrs"].get("output") == "summary"
    assert scripts[2]["text"].strip() == "select count(*) as n from rows"
    assert widget.cells[2].name == "summary"


def test_observablehq_sql_client_id_wraps_after_the_largest_safe_id(
    script_tags: ScriptTags,
) -> None:
    notebook = obs.Notebook.from_observablehq_document(
        {
            "title": "Remote",
            "nodes": [
                {
                    "id": 9007199254740991,
                    "mode": "js",
                    "value": "rows = []",
                },
                {
                    "id": 2,
                    "mode": "sql",
                    "name": "summary",
                    "value": "select count(*) as n from rows",
                    "data": {
                        "source": {
                            "name": "rows",
                            "type": "cell",
                            "dialect": "array",
                        }
                    },
                },
            ],
        }
    )

    scripts = script_tags(notebook.to_notebook_html())

    assert [script["attrs"].get("id") for script in scripts] == [
        "9007199254740991",
        "1",
        "2",
    ]


def test_notebook_from_observablehq_suffixes_colliding_sql_client_output(
    observablehq_response: ObservableHQResponseInstaller,
    script_tags: ScriptTags,
) -> None:
    observablehq_response(
        {
            "title": "Remote",
            "nodes": [
                {
                    "id": 1,
                    "mode": "js",
                    "value": "// existing database client\nrowsDB = DuckDBClient.of()",
                },
                {"id": 2, "mode": "js", "value": "rows = []"},
                {
                    "id": 3,
                    "mode": "sql",
                    "name": "summary",
                    "value": "select count(*) as n from rows",
                    "data": {
                        "source": {
                            "name": "rows",
                            "type": "cell",
                            "dialect": "array",
                        }
                    },
                },
            ],
        }
    )

    widget = obs.Notebook.from_observablehq("@d3/sql-view", timeout=1)

    scripts = script_tags(widget.to_notebook_html())
    assert scripts[2]["attrs"].get("output") == "rowsDB2"
    assert scripts[2]["text"].strip() == ('rowsDB2 = DuckDBClient.of({["rows"]: rows})')
    assert scripts[3]["attrs"].get("database") == "var:rowsDB2"


def test_notebook_from_observablehq_converts_file_attachment_sql_nodes(
    observablehq_response: ObservableHQResponseInstaller,
    script_tags: ScriptTags,
) -> None:
    observablehq_response(
        {
            "title": "Remote",
            "nodes": [
                {
                    "id": 1,
                    "mode": "sql",
                    "name": "plants",
                    "pinned": True,
                    "value": 'select * from "Power_Plants"',
                    "data": {
                        "source": {
                            "name": "Power_Plants.csv",
                            "type": "FileAttachment",
                            "dialect": "csv",
                        },
                        "display": {"mode": "none"},
                    },
                },
            ],
        }
    )

    widget = obs.Notebook.from_observablehq("@d3/sql-view", timeout=1)

    scripts = script_tags(widget.to_notebook_html())
    assert scripts[0]["attrs"].get("type") == "application/vnd.observable.javascript"
    assert "hidden" in scripts[0]["attrs"]
    assert scripts[0]["attrs"].get("output") == "Power_PlantsDB"
    assert scripts[0]["text"].strip() == (
        'Power_PlantsDB = DuckDBClient.of({["Power_Plants"]: '
        'FileAttachment("Power_Plants.csv")})'
    )
    assert scripts[1]["attrs"].get("type") == "application/sql"
    assert scripts[1]["attrs"].get("database") == "var:Power_PlantsDB"
    assert scripts[1]["attrs"].get("output") == "plants"
    assert scripts[1]["text"].strip() == 'select * from "Power_Plants"'
    assert widget.cells[1].name == "plants"


def test_notebook_from_observablehq_converts_sqlite_file_sql_nodes(
    observablehq_response: ObservableHQResponseInstaller,
    script_tags: ScriptTags,
) -> None:
    observablehq_response(
        {
            "title": "Remote",
            "nodes": [
                {
                    "id": 1,
                    "mode": "sql",
                    "pinned": True,
                    "value": "select * from customers",
                    "data": {
                        "source": {
                            "name": "chinook.db",
                            "type": "FileAttachment",
                            "dialect": "sqlite",
                        }
                    },
                },
            ],
        }
    )

    widget = obs.Notebook.from_observablehq("@d3/sql-view", timeout=1)

    scripts = script_tags(widget.to_notebook_html())
    assert scripts[0]["attrs"].get("type") == "application/vnd.observable.javascript"
    assert "hidden" in scripts[0]["attrs"]
    assert scripts[0]["attrs"].get("output") == "chinookDB"
    assert scripts[0]["text"].strip() == (
        'chinookDB = FileAttachment("chinook.db").sqlite()'
    )
    assert scripts[1]["attrs"].get("type") == "application/sql"
    assert scripts[1]["attrs"].get("database") == "var:chinookDB"
    assert scripts[1]["text"].strip() == "select * from customers"


def test_notebook_from_observablehq_converts_sqlite_table_nodes(
    observablehq_response: ObservableHQResponseInstaller,
    script_tags: ScriptTags,
) -> None:
    observablehq_response(
        {
            "title": "Remote",
            "nodes": [
                {
                    "id": 1,
                    "mode": "table",
                    "pinned": True,
                    "data": {
                        "source": {
                            "name": "chinook.db",
                            "type": "FileAttachment",
                            "dialect": "sqlite",
                        },
                        "operations": {
                            "from": {"table": {"table": "customers"}},
                        },
                    },
                },
            ],
        }
    )

    widget = obs.Notebook.from_observablehq("@d3/table-view", timeout=1)

    scripts = script_tags(widget.to_notebook_html())
    assert scripts[0]["attrs"].get("output") == "chinookDB"
    assert scripts[0]["text"].strip() == (
        'chinookDB = FileAttachment("chinook.db").sqlite()'
    )
    assert scripts[1]["attrs"].get("type") == "application/vnd.observable.javascript"
    assert scripts[1]["text"].strip() == (
        'Inputs.table(await chinookDB.query("SELECT * FROM \\"customers\\""))'
    )


def test_notebook_from_observablehq_converts_sql_database_table_nodes(
    observablehq_response: ObservableHQResponseInstaller,
    script_tags: ScriptTags,
) -> None:
    observablehq_response(
        {
            "title": "Remote",
            "nodes": [
                {
                    "id": 1,
                    "mode": "js",
                    "value": 'import {db} from "@observablehq/google-merchandise-sales-data"',
                },
                {
                    "id": 2,
                    "mode": "table",
                    "pinned": True,
                    "data": {
                        "source": {
                            "name": "db",
                            "type": "cell",
                            "dialect": "sql",
                        },
                        "operations": {
                            "from": {"table": {"table": "items"}, "mimeType": None},
                            "sort": [{"column": "price_in_usd", "direction": "desc"}],
                            "slice": {"to": 1000, "from": 0},
                            "filter": [
                                {
                                    "type": "eq",
                                    "operands": [
                                        {"type": "column", "value": "category"},
                                        {"type": "primitive", "value": "Apparel"},
                                    ],
                                }
                            ],
                            "select": {
                                "columns": [
                                    "id",
                                    "name",
                                    "brand",
                                    "variant",
                                    "category",
                                    "price_in_usd",
                                ]
                            },
                        },
                    },
                },
            ],
        }
    )

    widget = obs.Notebook.from_observablehq("@d3/table-view", timeout=1)

    scripts = script_tags(widget.to_notebook_html())
    assert scripts[1]["attrs"].get("type") == "application/vnd.observable.javascript"
    assert scripts[1]["text"].strip() == (
        'Inputs.table(await db.query("SELECT \\"id\\", \\"name\\", \\"brand\\", '
        '\\"variant\\", \\"category\\", \\"price_in_usd\\" FROM \\"items\\" WHERE '
        '\\"category\\" = \'Apparel\' ORDER BY \\"price_in_usd\\" DESC LIMIT 1000"))'
    )


def test_notebook_from_observablehq_converts_sql_table_contains_and_in_filters(
    observablehq_response: ObservableHQResponseInstaller,
    script_tags: ScriptTags,
) -> None:
    observablehq_response(
        {
            "title": "Remote",
            "nodes": [
                {
                    "id": 1,
                    "mode": "js",
                    "value": 'db = FileAttachment("sql-murder-mystery.db").sqlite()',
                },
                {
                    "id": 2,
                    "mode": "table",
                    "pinned": True,
                    "data": {
                        "source": {
                            "name": "db",
                            "type": "cell",
                            "dialect": "sqlite",
                        },
                        "operations": {
                            "from": {"table": {"table": "interview"}},
                            "slice": {"to": 100, "from": 0},
                            "filter": [
                                {
                                    "type": "c",
                                    "operands": [
                                        {"type": "column", "value": "transcript"},
                                        {"type": "primitive", "value": "Annabel"},
                                    ],
                                },
                                {
                                    "type": "in",
                                    "operands": [
                                        {"type": "column", "value": "person_id"},
                                        {"type": "primitive", "value": "14887"},
                                        {"type": "primitive", "value": "16371"},
                                    ],
                                },
                            ],
                            "select": {"columns": ["person_id", "transcript"]},
                        },
                    },
                },
            ],
        }
    )

    widget = obs.Notebook.from_observablehq("@d3/table-view", timeout=1)

    scripts = script_tags(widget.to_notebook_html())
    assert scripts[1]["text"].strip() == (
        'Inputs.table(await db.query("SELECT \\"person_id\\", \\"transcript\\" FROM '
        '\\"interview\\" WHERE \\"transcript\\" LIKE \'%Annabel%\' AND '
        "\\\"person_id\\\" IN ('14887', '16371') LIMIT 100\"))"
    )


def test_notebook_from_observablehq_uses_cell_backed_sqlite_databases(
    observablehq_response: ObservableHQResponseInstaller,
    script_tags: ScriptTags,
) -> None:
    observablehq_response(
        {
            "title": "Remote",
            "nodes": [
                {
                    "id": 1,
                    "mode": "js",
                    "value": 'sampleDB = FileAttachment("chinook.db").sqlite()',
                },
                {
                    "id": 2,
                    "mode": "sql",
                    "pinned": True,
                    "value": "select * from customers",
                    "data": {
                        "source": {
                            "name": "sampleDB",
                            "type": "cell",
                            "dialect": "sqlite",
                        }
                    },
                },
            ],
        }
    )

    widget = obs.Notebook.from_observablehq("@d3/sql-view", timeout=1)

    scripts = script_tags(widget.to_notebook_html())
    assert scripts[0]["text"].strip() == (
        'sampleDB = FileAttachment("chinook.db").sqlite()'
    )
    assert scripts[1]["attrs"].get("type") == "application/sql"
    assert scripts[1]["attrs"].get("database") == "var:sampleDB"
    assert scripts[1]["text"].strip() == "select * from customers"


def test_notebook_from_observablehq_accepts_initial_variables(
    observablehq_response: ObservableHQResponseInstaller,
) -> None:
    observablehq_response(
        {
            "title": "Remote",
            "nodes": [{"id": 1, "mode": "js", "value": "py_answer + 1"}],
        }
    )

    widget = obs.Notebook.from_observablehq(
        "@d3/bar-chart",
        timeout=1,
        variables={"py_answer": 7},
    )

    assert widget.variables == {"py_answer": 7}


def test_notebook_from_observablehq_initial_variables_serialize_to_frontend_state(
    observablehq_response: ObservableHQResponseInstaller,
) -> None:
    observablehq_response(
        {
            "title": "Remote",
            "nodes": [{"id": 1, "mode": "js", "value": "py_answer + 1"}],
        }
    )

    widget = obs.Notebook.from_observablehq(
        "@d3/bar-chart",
        timeout=1,
        variables={"py_answer": 7},
    )

    assert notebook_session(widget).get_state(["_variables"])["_variables"] == {
        "py_answer": 7
    }
