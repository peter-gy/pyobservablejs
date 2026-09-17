"""Fetch public Observable source with its original cell languages."""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from html.parser import HTMLParser
from typing import Any, cast

from .types import ObservableDocument

_REFERENCE = re.compile(
    r"(?:[0-9a-f]{16}|@[\w-]+/[\w-]+(?:/\d+)?)(?:@(?:\d+|latest)|~\d+)?", re.ASCII
)
_FLIGHT_HEADER = re.compile(rb"([0-9a-f]*):")


def resolve_observablehq_url(specifier: str) -> str:
    value = specifier.strip().removeprefix("observable:")
    if "://" in value:
        url = urllib.parse.urlsplit(value)
        if url.scheme not in {"http", "https"} or url.netloc not in {
            "observablehq.com",
            "old.observablehq.com",
            "new.observablehq.com",
            "api.observablehq.com",
        }:
            raise ValueError(f"Invalid ObservableHQ notebook specifier: {specifier!r}")
        value = (
            url.path.removeprefix("/document/").removeprefix("/api/import/").lstrip("/")
        )
    value = value.removeprefix("d/").removesuffix(".js")
    if not _REFERENCE.fullmatch(value):
        raise ValueError(f"Invalid ObservableHQ notebook specifier: {specifier!r}")
    return "https://observablehq.com/" + (
        value if value.startswith("@") else f"d/{value}"
    )


def fetch_observablehq_document(
    specifier: str, *, timeout: float | None = 30
) -> ObservableDocument:
    url = resolve_observablehq_url(specifier)
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "User-Agent": "Mozilla/5.0",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            source = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        raise OSError(
            f"Unable to fetch ObservableHQ notebook {url}: HTTP {error.code}"
        ) from error
    except urllib.error.URLError as error:
        raise OSError(
            f"Unable to fetch ObservableHQ notebook {url}: {error.reason}"
        ) from error
    document = decode_observablehq_source(source)
    path = urllib.parse.urlsplit(url).path
    identity = path.removeprefix("/d/").split("@", 1)[0]
    if re.fullmatch(r"[0-9a-f]{16}", identity) and document.get("id") != identity:
        raise ValueError(f"ObservableHQ returned a different notebook for {url}")
    requested = path.rsplit("@", 1)[-1]
    if requested.isdecimal() and document.get("version") != int(requested):
        raise ValueError(
            f"ObservableHQ returned a different notebook revision for {url}"
        )
    return document


def decode_observablehq_source(source: str) -> ObservableDocument:
    if source.lstrip().startswith("{"):
        value = json.loads(source)
    else:
        page = _SourcePage()
        page.feed(source)
        if page.document is not None:
            value = page.document
        else:
            flight = _Flight("".join(page.chunks).encode("utf-8"))
            props = next(
                (
                    p
                    for record in flight.records.values()
                    for p in _notebook_props(record)
                ),
                None,
            )
            if props is None:
                raise ValueError("ObservableHQ response contains no notebook source")
            metadata = flight.resolve(props["metaPromise"])
            body = flight.resolve(props["bodyPromise"])
            if not isinstance(metadata, Mapping) or not isinstance(body, Mapping):
                raise ValueError(
                    "ObservableHQ notebook or requested revision is unavailable"
                )
            revision = flight.resolve(props.get("version", "$undefined"))
            value = {**metadata, "body": body}
            if revision is not None:
                value["latest_version"] = metadata.get("version")
                value["version"] = revision
    if not isinstance(value, Mapping):
        raise TypeError("ObservableHQ document response was not an object")
    return cast(ObservableDocument, unwrap_observable_document(value))


def unwrap_observable_document(document: Mapping[str, Any]) -> Mapping[str, Any]:
    if any(key in document for key in ("nodes", "cells", "body")):
        return document
    props = document.get("props", document)
    if isinstance(props, Mapping) and "pageProps" in props:
        page = props["pageProps"]
        notebook = page.get("initialNotebook") if isinstance(page, Mapping) else None
        if not isinstance(notebook, Mapping):
            raise ValueError("ObservableHQ page contains no notebook source")
        return notebook
    return document


class _SourcePage(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.chunks: list[str] = []
        self.document: dict[str, Any] | None = None
        self._script: list[str] | None = None
        self._next_data = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "script":
            self._script = []
            self._next_data = dict(attrs).get("id") == "__NEXT_DATA__"

    def handle_data(self, data: str) -> None:
        if self._script is not None:
            self._script.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag != "script" or self._script is None:
            return
        source = "".join(self._script).strip()
        self._script = None
        if self._next_data:
            self.document = json.loads(source)
        elif source.startswith("self.__next_f.push("):
            payload = json.loads(
                source[len("self.__next_f.push(") :].removesuffix(";").removesuffix(")")
            )
            if (
                isinstance(payload, list)
                and len(payload) == 2
                and payload[0] == 1
                and isinstance(payload[1], str)
            ):
                self.chunks.append(payload[1])


def _notebook_props(value: Any):
    if isinstance(value, dict):
        if "metaPromise" in value and "bodyPromise" in value:
            yield value
        for child in value.values():
            yield from _notebook_props(child)
    elif isinstance(value, list):
        for child in value:
            yield from _notebook_props(child)


class _Flight:
    """Decode the data records referenced by Observable's public notebook props."""

    def __init__(self, source: bytes) -> None:
        self.records: dict[str, Any] = {}
        self.text_records: set[str] = set()
        self._resolved: dict[str, Any] = {}
        position = 0
        while position < len(source):
            header = _FLIGHT_HEADER.match(source, position)
            if header is None:
                raise ValueError("Invalid ObservableHQ source record")
            key = header[1].decode("ascii")
            position = header.end()
            if source[position : position + 1] == b"T":
                comma = source.index(b",", position)
                size = int(source[position + 1 : comma], 16)
                position = comma + 1
                end = position + size
                if end > len(source):
                    raise ValueError("Truncated ObservableHQ source text")
                self.records[key] = source[position:end].decode("utf-8")
                self.text_records.add(key)
                position = end
            else:
                end = source.find(b"\n", position)
                if end == -1:
                    end = len(source)
                record = source[position:end]
                # Component, resource hint, error, and debug records are not notebook data.
                if record[:1] in b'[{"-0123456789ntf':
                    self.records[key] = json.loads(record)
                position = end + 1

    def resolve(self, value: Any, active: frozenset[str] = frozenset()) -> Any:
        if isinstance(value, dict):
            return {
                k: self.resolve(v, active)
                for k, v in value.items()
                if v != "$undefined"
            }
        if isinstance(value, list):
            return [self.resolve(v, active) for v in value]
        if not isinstance(value, str) or not value.startswith("$"):
            return value
        if value.startswith("$$"):
            return value[1:]
        if value == "$undefined":
            return None
        if value.startswith("$D"):
            return value[2:]
        match = re.fullmatch(r"\$(?:@|W)?([0-9a-f]+)((?::[^:]+)*)", value)
        if match is None:
            raise ValueError(f"Unsupported ObservableHQ source reference: {value!r}")
        key = match[1]
        if key in active:
            raise ValueError("Cyclic ObservableHQ source reference")
        reference = key + match[2]
        if reference in self._resolved:
            return self._resolved[reference]
        try:
            target = self.records[key]
            for field in match[2].split(":")[1:]:
                target = (
                    target[int(field)] if isinstance(target, list) else target[field]
                )
        except (KeyError, IndexError, TypeError) as error:
            raise ValueError(
                f"Invalid ObservableHQ source reference: {value!r}"
            ) from error
        # Length-delimited text is already literal, including a leading dollar sign.
        if key in self.text_records:
            return target
        resolved = self.resolve(target, active | {key})
        self._resolved[reference] = resolved
        return resolved
