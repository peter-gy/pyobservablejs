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
        "cells": [_lower_node(node) for node in nodes],
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


def _lower_node(node: ObservableNode) -> dict[str, Any]:
    if node.mode == "table":
        return _table_node_to_cell(node)
    if node.mode == "chart":
        return _chart_node_to_cell(node)
    return _code_node_to_cell(node)


def _code_node_to_cell(node: ObservableNode) -> dict[str, Any]:
    cell: dict[str, Any] = {
        "id": node.id,
        "value": "" if node.value is None else str(node.value),
        # ObservableHQ hosted notebooks label OJS cells as "js". Notebook Kit
        # reserves "js" for ES modules, so imported cells keep OJS semantics.
        "mode": "ojs" if node.mode == "js" else node.mode,
    }
    _copy_visibility_attrs(cell, node)
    for key in ("database", "format", "name", "output"):
        value = node.raw.get(key)
        if value is not None:
            cell[key] = value
    return cell


def _table_node_to_cell(node: ObservableNode) -> dict[str, Any]:
    source = _source_expression(node.raw.get("data"), fallback="[]")
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
    options = _chart_options(data)
    value = f"Plot.auto(await {source}, {options}).plot()"
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


def _chart_options(data: object) -> str:
    if not isinstance(data, Mapping):
        raise ValueError("Observable chart node is missing chart data")
    data_map = cast(Mapping[str, Any], data)
    config = data_map.get("config")
    if not isinstance(config, Mapping):
        raise ValueError("Observable chart node is missing chart config")
    config_map = cast(Mapping[str, Any], config)

    options: dict[str, Any] = {}
    for channel in ("x", "y", "fx", "fy", "color", "size"):
        value = _chart_channel(config_map.get(channel))
        if value is not None:
            options[channel] = value
    mark = _chart_channel(config_map.get("mark"))
    if mark is not None:
        options["mark"] = mark
    extra = config_map.get("options")
    if isinstance(extra, Mapping):
        options.update(extra)
    return _json_literal(options)


def _chart_channel(value: object) -> Any:
    if not isinstance(value, Mapping):
        return None
    value_map = cast(Mapping[str, Any], value)
    kind = value_map.get("type")
    if kind == "undefined":
        return None
    if kind in {"field", "constant"}:
        return value_map.get("value")
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
