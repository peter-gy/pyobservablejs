from __future__ import annotations

import asyncio
import base64
import dataclasses
import json
import pathlib
import subprocess
import textwrap
import urllib.parse
from collections.abc import Callable, Sequence
from typing import Any, Protocol

import observablejs as obs
import pytest


@dataclasses.dataclass(frozen=True)
class BrowserGraphCell:
    key: str
    id: int | None = None
    index: int | None = None
    defines: tuple[str, ...] = ()
    references: tuple[str, ...] = ()
    output: str | None = None
    runtime_outputs: tuple[str, ...] = ()


@dataclasses.dataclass(frozen=True)
class JavaScriptImport:
    kind: str
    specifier: str
    imported: tuple[str, ...] = ()
    exported: tuple[str, ...] = ()


ExpectedImport = tuple[str, bytes, tuple[str, ...], tuple[str, ...]]
ObservableHQResponseInstaller = Callable[
    [dict[str, Any]], list[tuple[str, float | None]]
]
ScriptTags = Callable[[str], list[dict[str, Any]]]
DocumentTitle = Callable[[str], str]
BrowserGraphSync = Callable[..., None]
BrowserValueSync = Callable[..., None]
CommentNodes = Callable[[str], list[str]]


def notebook_session(notebook: obs.Notebook) -> Any:
    """Return the private widget model used for browser protocol assertions."""

    return notebook._session or notebook._widget_session()


class BrowserGraphCellBuilder(Protocol):
    def __call__(
        self,
        key: str,
        *,
        id: int | None = None,
        index: int | None = None,
        defines: Sequence[str] = (),
        references: Sequence[str] = (),
        output: str | None = None,
        runtime_outputs: Sequence[str] = (),
    ) -> BrowserGraphCell: ...


def notebook_from_html_path(path: pathlib.Path, **kwargs: Any) -> obs.Notebook:
    kwargs.setdefault("embed_file_attachments", True)
    kwargs.setdefault("rewrite_imports", True)
    return obs.Notebook.from_html(
        path.read_text(encoding="utf-8"),
        base_path=path.parent,
        **kwargs,
    )


def script_by_id(scripts: list[dict[str, Any]], script_id: str) -> dict[str, Any]:
    matches = [script for script in scripts if script["attrs"].get("id") == script_id]
    assert len(matches) == 1
    return matches[0]


def assert_javascript_import_payloads(
    source: str,
    expected_imports: Sequence[ExpectedImport],
) -> None:
    actual_imports = decoded_data_imports(javascript_imports(source))
    assert actual_imports == [
        expected_import_payload(expected) for expected in expected_imports
    ]
    assert_no_relative_javascript_import_specifiers(source)


def assert_no_relative_javascript_import_specifiers(source: str) -> None:
    assert [
        specifier
        for specifier in javascript_import_specifiers(source)
        if specifier.startswith(("./", "../"))
    ] == []


def decoded_data_imports(
    records: Sequence[JavaScriptImport],
) -> list[tuple[str, str, bytes, tuple[str, ...], tuple[str, ...]]]:
    return [
        (record.kind, mime_type, payload, record.imported, record.exported)
        for record in records
        if record.specifier.startswith("data:")
        for mime_type, payload in [decode_data_url(record.specifier)]
    ]


def expected_import_payload(
    item: ExpectedImport,
) -> tuple[str, str, bytes, tuple[str, ...], tuple[str, ...]]:
    kind, payload, imported, exported = item
    return (kind, "text/javascript", payload, imported, exported)


def normalized_source(source: str) -> str:
    return textwrap.dedent(source).strip()


def normalized_source_with_embedded_imports(source: str) -> str:
    normalized = source
    for specifier in javascript_import_specifiers(source):
        if specifier.startswith("data:"):
            normalized = normalized.replace(specifier, "<embedded>")
    return normalized_source(normalized)


def line_indent(source: str, text: str) -> int:
    matches = [line for line in source.splitlines() if line.strip() == text]
    assert len(matches) == 1
    return len(matches[0]) - len(matches[0].lstrip(" "))


def decode_data_url(url: str) -> tuple[str, bytes]:
    header, data = url.split(",", 1)
    assert header.startswith("data:"), url
    metadata = header.removeprefix("data:").split(";")
    mime_type = metadata[0]
    payload = (
        base64.b64decode(data)
        if "base64" in metadata
        else urllib.parse.unquote_to_bytes(data)
    )
    return mime_type, payload


def javascript_imports(source: str) -> list[JavaScriptImport]:
    # The runtime package supplies acorn, the parser Notebook Kit also uses.
    result = subprocess.run(
        ["node", "-e", _JAVASCRIPT_IMPORT_SPECIFIER_SCRIPT],
        cwd=pathlib.Path(__file__).parents[2] / "runtime",
        input=source,
        text=True,
        capture_output=True,
        check=True,
    )
    parsed = json.loads(result.stdout)
    assert isinstance(parsed, list)
    assert all(isinstance(item, dict) for item in parsed)
    records: list[JavaScriptImport] = []
    for item in parsed:
        kind = item.get("kind")
        specifier = item.get("specifier")
        imported = item.get("imported")
        exported = item.get("exported")
        assert isinstance(kind, str)
        assert isinstance(specifier, str)
        assert isinstance(imported, list)
        assert all(isinstance(name, str) for name in imported)
        assert isinstance(exported, list)
        assert all(isinstance(name, str) for name in exported)
        records.append(
            JavaScriptImport(
                kind,
                specifier,
                imported=tuple(imported),
                exported=tuple(exported),
            )
        )
    return records


def javascript_import_specifiers(source: str) -> list[str]:
    return [record.specifier for record in javascript_imports(source)]


_JAVASCRIPT_IMPORT_SPECIFIER_SCRIPT = r"""
const acorn = require("acorn");
const walk = require("acorn-walk");

let source = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  source += chunk;
});
process.stdin.on("end", () => {
  let program;
  try {
    // Cell bodies may use top-level await and private names outside a class.
    program = acorn.parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      checkPrivateFields: false,
    });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const records = [];
  const name = (node) => (node.type === "Literal" ? String(node.value) : node.name);
  const text = (node) => {
    if (node.type === "Literal" && typeof node.value === "string") return node.value;
    if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked;
    return null;
  };
  const add = (kind, node, imported = [], exported = []) => {
    const specifier = text(node);
    if (specifier !== null) records.push({ start: node.start, kind, specifier, imported, exported });
  };
  walk.full(program, (node) => {
    if (node.type === "ImportDeclaration") {
      const imported = node.specifiers.map((item) =>
        item.type === "ImportDefaultSpecifier" ? "default" : item.type === "ImportNamespaceSpecifier" ? "*" : name(item.imported),
      );
      add("import", node.source, imported);
    } else if (node.type === "ExportNamedDeclaration" && node.source) {
      add("export", node.source, [], node.specifiers.map((item) => name(item.local)));
    } else if (node.type === "ExportAllDeclaration") {
      add("export", node.source);
    } else if (node.type === "ImportExpression") {
      add("dynamic-import", node.source);
    }
  });
  records.sort((left, right) => left.start - right.start);
  process.stdout.write(JSON.stringify(records.map(({ start, ...record }) => record)));
});
"""


class Browser:
    def __init__(self, view: obs.NotebookView, monkeypatch: pytest.MonkeyPatch):
        self.view = view
        self.messages: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        monkeypatch.setattr(view, "send", self.send)

    def send(self, content: dict[str, Any], buffers: object = None) -> None:
        self.messages.put_nowait(content)

    def deliver(self, *, buffers: tuple[bytes, ...] = (), **content: object) -> None:
        self.view._handle_custom_msg(
            {"kind": "observablejs:access", "protocol": 1, **content},
            list(buffers),
        )

    def ready(self, generation: str = "first", value: object = None) -> None:
        self.view.set_trait("_inspection", {"generation": generation, "value": value})

    def catalog(self, values: object, generation: str = "first") -> None:
        self.view.set_trait("_datasets", {"generation": generation, "values": values})

    async def message(self) -> dict[str, Any]:
        return await asyncio.wait_for(self.messages.get(), 1)

    def reply(
        self,
        request: dict[str, Any],
        result: object,
        *,
        buffers: tuple[bytes, ...] = (),
    ) -> None:
        self.deliver(
            type="response",
            id=request["id"],
            generation=request["generation"],
            result=result,
            buffers=buffers,
        )
