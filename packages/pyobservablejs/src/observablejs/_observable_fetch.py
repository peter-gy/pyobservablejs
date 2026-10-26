"""Fetch public Observable notebooks from the ObservableHQ document API."""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from typing import cast

from .types import ObservableDocument

_REFERENCE = re.compile(
    r"(?:[0-9a-f]{16}|@[\w-]+/[\w-]+(?:/\d+)?)(?:@(?:\d+|latest)|~\d+)?", re.ASCII
)
# observablehq.com pages sit behind a browser challenge. The document API is the
# endpoint Notebook Kit's `notebooks download` reads.
_DOCUMENT_API = "https://api.observablehq.com/document/"


def _observablehq_reference(specifier: str) -> str:
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
    return value


def resolve_observablehq_url(specifier: str) -> str:
    reference = _observablehq_reference(specifier)
    return "https://observablehq.com/" + (
        reference if reference.startswith("@") else f"d/{reference}"
    )


def fetch_observablehq_document(
    specifier: str, *, timeout: float | None = 30
) -> ObservableDocument:
    reference = _observablehq_reference(specifier)
    url = _DOCUMENT_API + reference
    request = urllib.request.Request(
        url, headers={"Accept": "application/json", "User-Agent": "pyobservablejs"}
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            document = json.loads(response.read())
    except urllib.error.HTTPError as error:
        raise OSError(
            f"Unable to fetch ObservableHQ notebook {url}: HTTP {error.code}"
        ) from error
    except urllib.error.URLError as error:
        raise OSError(
            f"Unable to fetch ObservableHQ notebook {url}: {error.reason}"
        ) from error
    except ValueError as error:
        raise ValueError(f"ObservableHQ returned invalid JSON for {url}") from error
    if not isinstance(document, Mapping):
        raise TypeError("ObservableHQ document response was not an object")
    identity = reference.split("@", 1)[0]
    if re.fullmatch(r"[0-9a-f]{16}", identity) and document.get("id") != identity:
        raise ValueError(f"ObservableHQ returned a different notebook for {url}")
    requested = reference.rsplit("@", 1)[-1]
    if requested.isdecimal() and document.get("version") != int(requested):
        raise ValueError(
            f"ObservableHQ returned a different notebook revision for {url}"
        )
    return cast(ObservableDocument, document)
