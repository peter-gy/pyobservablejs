from __future__ import annotations

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


@dataclasses.dataclass(frozen=True)
class BrowserGraphCell:
    key: str
    id: int | None = None
    index: int | None = None
    name: str | None = None
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


class BrowserGraphCellBuilder(Protocol):
    def __call__(
        self,
        key: str,
        *,
        id: int | None = None,
        index: int | None = None,
        name: str | None = None,
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
    result = subprocess.run(
        ["node", "-e", _JAVASCRIPT_IMPORT_SPECIFIER_SCRIPT],
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
const ts = require("typescript");

let source = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  source += chunk;
});
process.stdin.on("end", () => {
  const file = ts.createSourceFile("cell.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (file.parseDiagnostics.length > 0) {
    console.error(file.parseDiagnostics.map((item) => item.messageText).join("\n"));
    process.exit(1);
  }

  const records = [];
  const namedImports = (importClause) => {
    if (!importClause) return [];
    const names = [];
    if (importClause.name) names.push("default");
    const bindings = importClause.namedBindings;
    if (!bindings) return names;
    if (ts.isNamespaceImport(bindings)) return [...names, "*"];
    return [...names, ...bindings.elements.map((item) => (item.propertyName ?? item.name).text)];
  };
  const namedExports = (exportClause) => {
    if (!exportClause || !ts.isNamedExports(exportClause)) return [];
    return exportClause.elements.map((item) => (item.propertyName ?? item.name).text);
  };
  const addLiteral = (kind, node, imported = [], exported = []) => {
    if (node && typeof node.text === "string") {
      records.push({kind, specifier: node.text, imported, exported});
    }
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      addLiteral("import", node.moduleSpecifier, namedImports(node.importClause));
    } else if (ts.isExportDeclaration(node)) {
      addLiteral("export", node.moduleSpecifier, [], namedExports(node.exportClause));
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0
    ) {
      addLiteral("dynamic-import", node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };

  visit(file);
  process.stdout.write(JSON.stringify(records));
});
"""
