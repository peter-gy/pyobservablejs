"""Convert public ObservableHQ documents to Notebook Kit inputs."""

from __future__ import annotations

import datetime as _dt
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from typing import Any

from ._serialize import serialize

_UI_ORIGIN = "https://observablehq.com"
_ID_SPECIFIER_RE = re.compile(r"^[0-9a-f]{16}(?:@\d+|@latest|@\w+|~\d+)?$")
_SLUG_SPECIFIER_RE = re.compile(
    r"^@[0-9a-z_-]+/[0-9a-z_-]+(?:/\d+)?(?:@\d+|@latest|@\w+|~\d+)?$"
)


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

    nodes = document.get("nodes")
    if not isinstance(nodes, list):
        raise ValueError("Observable document response is missing a nodes list")
    spec = {
        "title": document.get("title") or "Untitled",
        "theme": "air",
        "cells": [_node_to_cell(node, index) for index, node in enumerate(nodes)],
    }
    return serialize(spec), _files_to_attachments(document.get("files"))


def _node_to_cell(node: object, index: int) -> dict[str, Any]:
    if not isinstance(node, Mapping):
        raise ValueError("Observable document node must be an object")
    node = dict(node)

    mode = str(node.get("mode") or "js")
    value = node.get("value")
    cell: dict[str, Any] = {
        "id": _node_id(node.get("id"), index),
        "value": "" if value is None else str(value),
        "mode": "ojs" if mode == "js" else mode,
    }
    if node.get("pinned") is True:
        cell["pinned"] = True
    if node.get("hidden") is True:
        cell["hidden"] = True
    for key in ("database", "format", "name", "output"):
        value = node.get(key)
        if value is not None:
            cell[key] = value
    return cell


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
