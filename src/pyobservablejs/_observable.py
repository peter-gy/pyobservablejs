"""Convert public ObservableHQ documents to Notebook Kit inputs."""

from __future__ import annotations

import datetime as _dt
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, cast

from ._serialize import serialize

_UI_ORIGIN = "https://observablehq.com"
_ID_SPECIFIER_RE = re.compile(r"^[0-9a-f]{16}(?:@\d+|@latest|@\w+|~\d+)?$")
_SLUG_SPECIFIER_RE = re.compile(
    r"^@[0-9a-z_-]+/[0-9a-z_-]+(?:/\d+)?(?:@\d+|@latest|@\w+|~\d+)?$"
)
_JS_IDENTIFIER_RE = re.compile(r"^[A-Za-z_$][0-9A-Za-z_$]*$")
_OJS_OUTPUT_RE = re.compile(
    r"^\s*(?:mutable\s+|viewof\s+)?([A-Za-z_$][0-9A-Za-z_$]*)\s*="
)
_LEGACY_DUCKDB_IMPORT_RE = re.compile(
    r"""^\s*import\s*\{\s*DuckDBClient\s*\}\s*from\s*["']@cmudig/duckdb["']\s*;?\s*$"""
)


@dataclass(frozen=True)
class ObservableNode:
    index: int
    id: int
    mode: str
    value: object
    name: str | None
    pinned: bool
    hidden: bool
    raw: Mapping[str, Any]


@dataclass(frozen=True)
class SqlSource:
    name: str
    source_type: str | None
    dialect: str | None


def resolve_observablehq_api_url(specifier: str) -> str:
    """Return the ObservableHQ document API URL for a public notebook specifier."""

    value = specifier.strip()
    if _ID_SPECIFIER_RE.fullmatch(value):
        value = f"{_UI_ORIGIN}/d/{value}"
    elif _SLUG_SPECIFIER_RE.fullmatch(value):
        value = f"{_UI_ORIGIN}/{value}"

    url = urllib.parse.urlsplit(value)
    if not url.scheme or not url.netloc:
        raise ValueError(f"Invalid ObservableHQ notebook specifier: {specifier!r}")
    if url.netloc not in {"observablehq.com", "api.observablehq.com"}:
        raise ValueError(f"Invalid ObservableHQ notebook specifier: {specifier!r}")

    if url.path.startswith("/document/"):
        api_path = url.path
    else:
        path = (
            url.path.replace("/d/", "/", 1) if url.path.startswith("/d/") else url.path
        )
        api_path = f"/document{path}"
    return urllib.parse.urlunsplit(
        (url.scheme, "api.observablehq.com", api_path, url.query, "")
    )


def fetch_observablehq_notebook(
    specifier: str,
    *,
    timeout: float | None = 30,
) -> tuple[str, dict[str, dict[str, Any]]]:
    """Fetch a public ObservableHQ notebook and return Notebook Kit HTML plus files."""

    api_url = resolve_observablehq_api_url(specifier)
    request = urllib.request.Request(
        api_url,
        headers={
            "Accept": "application/json",
            "User-Agent": "pyobservablejs",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        raise OSError(
            f"Unable to fetch ObservableHQ notebook {api_url}: HTTP {error.code}"
        ) from error
    except urllib.error.URLError as error:
        raise OSError(
            f"Unable to fetch ObservableHQ notebook {api_url}: {error.reason}"
        ) from error

    try:
        document = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ValueError(
            f"ObservableHQ document response was not JSON: {api_url}"
        ) from error
    return observable_document_to_html(document)


def observable_document_to_html(
    document: Mapping[str, Any],
) -> tuple[str, dict[str, dict[str, Any]]]:
    """Convert an Observable document API response to Notebook Kit inputs."""

    nodes = [
        _normalize_node(node, index)
        for index, node in enumerate(_document_nodes(document))
    ]
    spec = {
        "title": document.get("title") or "Untitled",
        "theme": "air",
        "cells": _lower_nodes(nodes),
    }
    return serialize(spec), _files_to_attachments(document.get("files"))


def _document_nodes(document: Mapping[str, Any]) -> list[object]:
    nodes = document.get("nodes")
    if not isinstance(nodes, list):
        raise ValueError("Observable document response is missing a nodes list")
    return nodes


def _normalize_node(node: object, index: int) -> ObservableNode:
    if not isinstance(node, Mapping):
        raise ValueError("Observable document node must be an object")
    raw = dict(node)
    mode = raw.get("mode") or "js"
    if not isinstance(mode, str):
        mode = str(mode)
    return ObservableNode(
        index=index,
        id=_node_id(raw.get("id"), index),
        mode=mode,
        value=raw.get("value"),
        name=_valid_cell_name(raw.get("name")),
        pinned=raw.get("pinned") is True,
        hidden=raw.get("hidden") is True,
        raw=raw,
    )


def _lower_nodes(nodes: list[ObservableNode]) -> list[dict[str, Any]]:
    cells: list[dict[str, Any]] = []
    sql_clients: dict[str, str] = {}
    used_names = set[str]()
    use_builtin_duckdb = _can_use_builtin_duckdb_client(nodes)
    for node in nodes:
        if node.name is not None:
            used_names.add(node.name)
        if output_name := _cell_output_name(node):
            used_names.add(output_name)
    next_id = max((node.id for node in nodes), default=0) + 1

    for node in nodes:
        sql_database = _sql_database(node)
        if sql_database is None:
            source = _sql_source(node)
            if source is not None:
                if source.source_type == "cell" and source.dialect in {
                    "duckdb",
                    "sqlite",
                    "sql",
                }:
                    sql_database = source.name
                elif source.source_type == "cell" and source.dialect == "array":
                    sql_database = sql_clients.get(source.name)
                    if sql_database is None:
                        sql_database = _generated_sql_client_name(
                            source.name, used_names
                        )
                        used_names.add(sql_database)
                        sql_clients[source.name] = sql_database
                        cells.append(
                            _sql_client_cell(
                                id=next_id,
                                name=sql_database,
                                table_name=source.name,
                                source_expression=source.name,
                            )
                        )
                        next_id += 1
                elif (
                    source.source_type == "FileAttachment"
                    and source.dialect == "sqlite"
                ):
                    sql_database = sql_clients.get(f"sqlite:{source.name}")
                    if sql_database is None:
                        sql_database = _generated_sql_client_name(
                            _js_identifier_from_name(
                                _attachment_table_name(source.name)
                            ),
                            used_names,
                        )
                        used_names.add(sql_database)
                        sql_clients[f"sqlite:{source.name}"] = sql_database
                        cells.append(
                            _sqlite_client_cell(
                                id=next_id,
                                name=sql_database,
                                attachment_name=source.name,
                            )
                        )
                        next_id += 1
                elif source.source_type == "FileAttachment":
                    table_name = _attachment_table_name(source.name)
                    client_key = f"duckdb:{source.name}:{table_name}"
                    sql_database = sql_clients.get(client_key)
                    if sql_database is None:
                        sql_database = _generated_sql_client_name(
                            _js_identifier_from_name(table_name), used_names
                        )
                        used_names.add(sql_database)
                        sql_clients[client_key] = sql_database
                        cells.append(
                            _sql_client_cell(
                                id=next_id,
                                name=sql_database,
                                table_name=table_name,
                                source_expression=_file_attachment_object_expression(
                                    source.name
                                ),
                            )
                        )
                        next_id += 1
        cells.append(
            _lower_node(
                node,
                sql_database=sql_database,
                use_builtin_duckdb=use_builtin_duckdb,
            )
        )
    return cells


def _lower_node(
    node: ObservableNode,
    *,
    sql_database: str | None = None,
    use_builtin_duckdb: bool = False,
) -> dict[str, Any]:
    if node.mode == "table":
        return _table_node_to_cell(node, sql_database=sql_database)
    if node.mode == "chart":
        return _chart_node_to_cell(node)
    return _code_node_to_cell(
        node,
        sql_database=sql_database,
        use_builtin_duckdb=use_builtin_duckdb,
    )


def _code_node_to_cell(
    node: ObservableNode,
    *,
    sql_database: str | None = None,
    use_builtin_duckdb: bool = False,
) -> dict[str, Any]:
    value = "" if node.value is None else str(node.value)
    uses_builtin_duckdb = (
        use_builtin_duckdb
        and node.mode == "js"
        and _LEGACY_DUCKDB_IMPORT_RE.fullmatch(value)
    )
    cell: dict[str, Any] = {
        "id": node.id,
        "value": "undefined" if uses_builtin_duckdb else value,
        # ObservableHQ hosted notebooks label OJS cells as "js". Notebook Kit
        # reserves "js" for ES modules, so imported cells keep OJS semantics.
        "mode": "ojs" if node.mode == "js" else node.mode,
    }
    _copy_visibility_attrs(cell, node)
    if uses_builtin_duckdb:
        cell["hidden"] = True
    if node.mode in {"dot", "html", "md", "sql", "tex"} and node.name is not None:
        cell["output"] = node.name
    if sql_database is not None:
        cell["database"] = f"var:{sql_database}"
    for key in ("database", "format", "name", "output"):
        value = node.raw.get(key)
        if value is not None and key not in cell:
            cell[key] = value
    return cell


def _can_use_builtin_duckdb_client(nodes: list[ObservableNode]) -> bool:
    values = ["" if node.value is None else str(node.value) for node in nodes]
    if not any(
        node.mode == "js" and _LEGACY_DUCKDB_IMPORT_RE.fullmatch(value)
        for node, value in zip(nodes, values, strict=True)
    ):
        return False
    source = "\n".join(values)
    legacy_only_patterns = (
        r"\bnew\s+DuckDBClient\s*\(",
        r"\.describe\s*\(",
        r"\.insertCSV\s*\(",
        r"\.insertJSON\s*\(",
        r"\.db\s*\(",
        r"\.table\s*\(",
        r"\.client\s*\(",
        r"\.summarize\s*\(",
        r"\.explain\s*\(",
    )
    return not any(re.search(pattern, source) for pattern in legacy_only_patterns)


def _sql_client_cell(
    *,
    id: int,
    name: str,
    table_name: str,
    source_expression: str,
) -> dict[str, Any]:
    return {
        "id": id,
        "value": (
            f"{name} = DuckDBClient.of({{"
            f"[{_json_literal(table_name)}]: {source_expression}"
            "})"
        ),
        "mode": "ojs",
        "hidden": True,
        "output": name,
    }


def _sqlite_client_cell(
    *,
    id: int,
    name: str,
    attachment_name: str,
) -> dict[str, Any]:
    return {
        "id": id,
        "value": (
            f"{name} = FileAttachment({_json_literal(attachment_name)}).sqlite()"
        ),
        "mode": "ojs",
        "hidden": True,
        "output": name,
    }


def _sql_database(node: ObservableNode) -> str | None:
    if node.mode != "sql":
        return None
    value = node.raw.get("database")
    return value if isinstance(value, str) and value else None


def _sql_source(node: ObservableNode) -> SqlSource | None:
    if node.mode not in {"sql", "table"}:
        return None
    data = node.raw.get("data")
    if not isinstance(data, Mapping):
        return None
    data_map = cast(Mapping[str, Any], data)
    source = data_map.get("source")
    if not isinstance(source, Mapping):
        return None
    source_map = cast(Mapping[str, Any], source)
    source_type = source_map.get("type")
    name = source_map.get("name")
    if not isinstance(name, str) or not name:
        return None
    if node.mode == "table" and not isinstance(data_map.get("operations"), Mapping):
        return None
    if source_type == "cell" and not _JS_IDENTIFIER_RE.fullmatch(name):
        return None
    dialect = source_map.get("dialect")
    return SqlSource(
        name=name,
        source_type=source_type if isinstance(source_type, str) else None,
        dialect=dialect if isinstance(dialect, str) else None,
    )


def _generated_sql_client_name(source_name: str, used_names: set[str]) -> str:
    base = f"{source_name}DB"
    name = base
    suffix = 2
    while name in used_names:
        name = f"{base}{suffix}"
        suffix += 1
    return name


def _attachment_table_name(name: str) -> str:
    path_name = name.rsplit("/", 1)[-1]
    if "." not in path_name:
        return path_name
    return path_name.rsplit(".", 1)[0]


def _js_identifier_from_name(name: str) -> str:
    chars = [char if char.isalnum() or char in {"_", "$"} else "_" for char in name]
    value = "".join(chars).strip("_") or "attachment"
    if not re.match(r"^[A-Za-z_$]", value):
        value = f"_{value}"
    return value


def _file_attachment_object_expression(name: str) -> str:
    return f"FileAttachment({_json_literal(name)})"


def _table_node_to_cell(
    node: ObservableNode,
    *,
    sql_database: str | None = None,
) -> dict[str, Any]:
    data = node.raw.get("data")
    sql_query = _table_sql_query(data)
    if sql_database is not None and sql_query is not None:
        value = f"Inputs.table(await {sql_database}.query({_json_literal(sql_query)}))"
    else:
        source = _source_expression(data, fallback="[]")
        value = f"Inputs.table(await {source})"
    if node.name is not None:
        value = f"viewof {node.name} = {value}"
    cell: dict[str, Any] = {
        "id": node.id,
        "value": value,
        "mode": "ojs",
    }
    _copy_visibility_attrs(cell, node)
    if _data_display_mode(node.raw.get("data")) == "none":
        cell["hidden"] = True
    if node.name is not None:
        cell["name"] = node.name
    return cell


def _chart_node_to_cell(node: ObservableNode) -> dict[str, Any]:
    data = node.raw.get("data")
    source = _source_expression(data, fallback="[]")
    options = _chart_options_dict(data)
    value = (
        "undefined"
        if not options
        else f"Plot.auto(await {source}, {_json_literal(options)}).plot()"
    )
    if node.name is not None:
        value = f"{node.name} = {value}"
    cell: dict[str, Any] = {
        "id": node.id,
        "value": value,
        "mode": "ojs",
    }
    _copy_visibility_attrs(cell, node)
    if node.name is not None:
        cell["name"] = node.name
    return cell


def _copy_visibility_attrs(cell: dict[str, Any], node: ObservableNode) -> None:
    if node.pinned:
        cell["pinned"] = True
    if node.hidden:
        cell["hidden"] = True


def _source_expression(data: object, *, fallback: str | None = None) -> str:
    if not isinstance(data, Mapping):
        if fallback is not None:
            return fallback
        raise ValueError("Observable data node is missing source data")
    data_map = cast(Mapping[str, Any], data)
    source = data_map.get("source")
    if not isinstance(source, Mapping):
        if fallback is not None:
            return fallback
        raise ValueError("Observable data node is missing source data")
    source_map = cast(Mapping[str, Any], source)
    name = source_map.get("name")
    if not isinstance(name, str) or not name:
        if fallback is not None:
            return fallback
        raise ValueError("Observable data node source is missing a name")
    source_type = source_map.get("type")
    if source_type == "FileAttachment":
        return _file_attachment_expression(name)
    if _JS_IDENTIFIER_RE.fullmatch(name):
        return name
    raise ValueError("Observable data node cell source must be a JavaScript identifier")


def _file_attachment_expression(name: str) -> str:
    attachment = f"FileAttachment({_json_literal(name)})"
    lower = name.lower()
    if lower.endswith(".csv"):
        return f"{attachment}.csv({{typed: true}})"
    if lower.endswith(".tsv"):
        return f"{attachment}.tsv({{typed: true}})"
    if lower.endswith(".json"):
        return f"{attachment}.json()"
    if lower.endswith(".arrow"):
        return f"{attachment}.arrow()"
    if lower.endswith(".parquet"):
        return f"{attachment}.parquet()"
    return f"{attachment}.json()"


def _table_sql_query(data: object) -> str | None:
    if not isinstance(data, Mapping):
        return None
    data_map = cast(Mapping[str, Any], data)
    operations = data_map.get("operations")
    if not isinstance(operations, Mapping):
        return None
    operations_map = cast(Mapping[str, Any], operations)
    source = data_map.get("source")
    if not isinstance(source, Mapping):
        return None
    from_value = operations_map.get("from")
    if not isinstance(from_value, Mapping):
        return None
    from_map = cast(Mapping[str, Any], from_value)
    table = from_map.get("table")
    if not isinstance(table, Mapping):
        return None
    table_map = cast(Mapping[str, Any], table)
    table_name = table_map.get("table")
    if not isinstance(table_name, str) or not table_name:
        return None
    select_clause = _table_select_clause(operations_map.get("select"))
    if select_clause is None:
        return None
    filter_clause = _table_filter_clause(operations_map.get("filter"))
    if filter_clause is None:
        return None
    sort_clause = _table_sort_clause(operations_map.get("sort"))
    if sort_clause is None:
        return None
    slice_clause = _table_slice_clause(operations_map.get("slice"))
    if slice_clause is None:
        return None
    return (
        f"SELECT {select_clause} FROM {_sql_identifier(table_name)}"
        f"{filter_clause}{sort_clause}{slice_clause}"
    )


def _sqlite_identifier(name: str) -> str:
    return _sql_identifier(name)


def _sql_identifier(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _table_select_clause(select: object) -> str | None:
    if not isinstance(select, Mapping):
        return "*"
    select_map = cast(Mapping[str, Any], select)
    columns = select_map.get("columns")
    if columns is None:
        return "*"
    if not isinstance(columns, list) or not all(
        isinstance(column, str) and column for column in columns
    ):
        return None
    return ", ".join(_sql_identifier(column) for column in columns)


def _table_filter_clause(filters: object) -> str | None:
    if filters in (None, []):
        return ""
    if not isinstance(filters, list):
        return None
    clauses: list[str] = []
    for filter_spec in filters:
        clause = _table_filter_expression(filter_spec)
        if clause is None:
            return None
        clauses.append(clause)
    return "" if not clauses else " WHERE " + " AND ".join(clauses)


def _table_filter_expression(filter_spec: object) -> str | None:
    if not isinstance(filter_spec, Mapping):
        return None
    filter_map = cast(Mapping[str, Any], filter_spec)
    filter_type = filter_map.get("type")
    operands = filter_map.get("operands")
    if not isinstance(operands, list) or len(operands) < 2:
        return None
    if filter_type == "in":
        left = _table_operand_expression(operands[0])
        values = [_table_operand_expression(operand) for operand in operands[1:]]
        if left is None or any(value is None for value in values):
            return None
        return f"{left} IN ({', '.join(cast(list[str], values))})"
    if filter_type == "c":
        left = _table_operand_expression(operands[0])
        value = _table_primitive_value(operands[1])
        if left is None or value is None:
            return None
        return f"{left} LIKE {_sql_literal(f'%{value}%')}"
    if not isinstance(filter_type, str):
        return None
    operator = {
        "eq": "=",
        "neq": "<>",
        "lt": "<",
        "lte": "<=",
        "gt": ">",
        "gte": ">=",
    }.get(filter_type)
    if operator is None:
        return None
    if len(operands) != 2:
        return None
    left = _table_operand_expression(operands[0])
    right = _table_operand_expression(operands[1])
    if left is None or right is None:
        return None
    return f"{left} {operator} {right}"


def _table_operand_expression(operand: object) -> str | None:
    if not isinstance(operand, Mapping):
        return None
    operand_map = cast(Mapping[str, Any], operand)
    operand_type = operand_map.get("type")
    value = operand_map.get("value")
    if operand_type == "column" and isinstance(value, str) and value:
        return _sql_identifier(value)
    if operand_type == "primitive":
        return _sql_literal(value)
    return None


def _table_primitive_value(operand: object) -> object | None:
    if not isinstance(operand, Mapping):
        return None
    operand_map = cast(Mapping[str, Any], operand)
    if operand_map.get("type") != "primitive":
        return None
    return operand_map.get("value")


def _sql_literal(value: object) -> str:
    if value is None:
        return "NULL"
    if value is True:
        return "TRUE"
    if value is False:
        return "FALSE"
    if isinstance(value, int | float):
        return json.dumps(value)
    return "'" + str(value).replace("'", "''") + "'"


def _table_sort_clause(sort: object) -> str | None:
    if sort in (None, []):
        return ""
    if not isinstance(sort, list):
        return None
    parts: list[str] = []
    for item in sort:
        if not isinstance(item, Mapping):
            return None
        item_map = cast(Mapping[str, Any], item)
        column = item_map.get("column")
        if not isinstance(column, str) or not column:
            return None
        direction = item_map.get("direction")
        if direction is None:
            direction_sql = "ASC"
        elif isinstance(direction, str) and direction.lower() in {"asc", "desc"}:
            direction_sql = direction.upper()
        else:
            return None
        parts.append(f"{_sql_identifier(column)} {direction_sql}")
    return "" if not parts else " ORDER BY " + ", ".join(parts)


def _table_slice_clause(slice_spec: object) -> str | None:
    if not isinstance(slice_spec, Mapping):
        return ""
    slice_map = cast(Mapping[str, Any], slice_spec)
    from_value = slice_map.get("from")
    to_value = slice_map.get("to")
    if from_value is not None and (
        not isinstance(from_value, int)
        or isinstance(from_value, bool)
        or from_value < 0
    ):
        return None
    if to_value is not None and (
        not isinstance(to_value, int) or isinstance(to_value, bool) or to_value < 0
    ):
        return None
    if from_value is None and to_value is None:
        return ""
    offset = 0 if from_value is None else from_value
    if to_value is None:
        return f" OFFSET {offset}" if offset else ""
    limit = max(0, to_value - offset)
    return f" LIMIT {limit}" + (f" OFFSET {offset}" if offset else "")


def _chart_options(data: object) -> str:
    return _json_literal(_chart_options_dict(data))


def _chart_options_dict(data: object) -> dict[str, Any]:
    if not isinstance(data, Mapping):
        raise ValueError("Observable chart node is missing chart data")
    data_map = cast(Mapping[str, Any], data)
    config = data_map.get("config")
    if not isinstance(config, Mapping):
        raise ValueError("Observable chart node is missing chart config")
    config_map = cast(Mapping[str, Any], config)

    extra = config_map.get("options")
    extra_options = dict(extra) if isinstance(extra, Mapping) else {}
    channel_names = {"x", "y", "fx", "fy", "color", "size"}
    options: dict[str, Any] = {}
    for channel in ("x", "y", "fx", "fy", "color", "size"):
        value = _chart_channel(
            config_map.get(channel),
            extra_options.get(channel),
        )
        if value is not None:
            options[channel] = value
    mark = _chart_channel(config_map.get("mark"))
    if mark is not None:
        options["mark"] = mark
    for key, value in extra_options.items():
        if key not in channel_names:
            options[key] = value
    return options


def _chart_channel(
    value: object,
    extra_options: object | None = None,
) -> Any:
    if not isinstance(value, Mapping):
        return None
    value_map = cast(Mapping[str, Any], value)
    kind = value_map.get("type")
    if kind == "undefined":
        return None
    if kind in {"field", "constant"}:
        channel_value = value_map.get("value")
        reduce_value = value_map.get("reduce")
        if isinstance(extra_options, Mapping) or reduce_value is not None:
            channel_options = (
                dict(extra_options) if isinstance(extra_options, Mapping) else {}
            )
            channel_options["value"] = channel_value
            if reduce_value is not None:
                channel_options["reduce"] = reduce_value
            return channel_options
        return channel_value
    return None


def _data_display_mode(data: object) -> str | None:
    if not isinstance(data, Mapping):
        return None
    data_map = cast(Mapping[str, Any], data)
    display = data_map.get("display")
    if not isinstance(display, Mapping):
        return None
    display_map = cast(Mapping[str, Any], display)
    mode = display_map.get("mode")
    return mode if isinstance(mode, str) else None


def _valid_cell_name(value: object) -> str | None:
    if isinstance(value, str) and _JS_IDENTIFIER_RE.fullmatch(value):
        return value
    return None


def _cell_output_name(node: ObservableNode) -> str | None:
    if node.mode != "js" or not isinstance(node.value, str):
        return None
    for line in node.value.splitlines():
        if line.lstrip().startswith("//"):
            continue
        match = _OJS_OUTPUT_RE.match(line)
        if match:
            return match.group(1)
    return None


def _json_literal(value: object) -> str:
    return json.dumps(value, ensure_ascii=False)


def _node_id(value: object, index: int) -> int:
    if isinstance(value, bool):
        return index + 1
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return index + 1
    return index + 1


def _files_to_attachments(files: object) -> dict[str, dict[str, Any]]:
    if not isinstance(files, list):
        return {}
    attachments: dict[str, dict[str, Any]] = {}
    for item in files:
        if not isinstance(item, Mapping):
            continue
        item = dict(item)
        name = item.get("name")
        url = item.get("download_url")
        if not isinstance(name, str) or not isinstance(url, str):
            continue
        info: dict[str, Any] = {"url": url}
        mime_type = item.get("mime_type")
        size = item.get("size")
        create_time = item.get("create_time")
        if isinstance(mime_type, str):
            info["mimeType"] = mime_type
        if isinstance(size, int):
            info["size"] = size
        if isinstance(create_time, str):
            last_modified = _iso_timestamp_ms(create_time)
            if last_modified is not None:
                info["lastModified"] = last_modified
        attachments[name] = info
    return attachments


def _iso_timestamp_ms(value: str) -> int | None:
    try:
        parsed = _dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return int(parsed.timestamp() * 1000)
