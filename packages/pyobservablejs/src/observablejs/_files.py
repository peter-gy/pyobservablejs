"""Prepare Notebook Kit HTML sources for widget rendering.

Source-backed notebooks can reference local files with ``FileAttachment`` or
relative JavaScript imports. This module discovers those references inside real
notebook script cells and rewrites local assets to data URLs when the caller
requests embedded file attachments or import rewriting.
"""

from __future__ import annotations

import base64
import mimetypes
import pathlib
import re
from collections.abc import Mapping
from html.parser import HTMLParser
from typing import NamedTuple, cast

from .types import FileInput, FileSpec

FileAttachment = FileSpec

_JS_LINE_COMMENT_RE = r"//[^\n]*(?:\n|$)"
_JS_BLOCK_COMMENT_RE = r"/\*[^*]*\*+(?:[^/*][^*]*\*+)*/"
_JS_TRIVIA_RE = rf"(?:\s|{_JS_LINE_COMMENT_RE}|{_JS_BLOCK_COMMENT_RE})*"
_JS_IMPORT_CLAUSE_RE = (
    rf"(?:[^;\"'`/]|/(?![/*])|{_JS_LINE_COMMENT_RE}|{_JS_BLOCK_COMMENT_RE})*?"
)
_JS_IDENTIFIER_RE = r"[A-Za-z_$][0-9A-Za-z_$]*"
_FILE_ATTACHMENT_ARGUMENT_RE = (
    r"(?:(?P<quote>[\"'])(?P<quoted>(?:\\.|(?! (?P=quote)).)*?)(?P=quote)"
    r"|`(?P<template>(?:\\.|(?!`|\$\{).)*?)`)"
).replace(" ", "")
_STDLIB_IMPORT_RE = re.compile(
    rf"\bimport{_JS_TRIVIA_RE}\{{(?P<imports>.*?)\}}{_JS_TRIVIA_RE}"
    rf"from{_JS_TRIVIA_RE}(?P<quote>[\"'])observablehq:stdlib(?P=quote)",
    re.S,
)
_NON_JAVASCRIPT_SCRIPT_TYPES = {
    "application/sql",
    "application/x-tex",
    "text/html",
    "text/markdown",
    "text/vnd.graphviz",
    "text/x-python",
    "text/x-r",
}
_REGEX_PREFIX_KEYWORDS = {
    "await",
    "case",
    "delete",
    "do",
    "else",
    "extends",
    "in",
    "instanceof",
    "new",
    "of",
    "return",
    "throw",
    "typeof",
    "void",
    "yield",
}
_CONTROL_CONDITION_KEYWORDS = {"catch", "for", "if", "while", "with"}


class _ScriptBlock(NamedTuple):
    start: int
    open: str
    attrs: str
    body_start: int
    body: str
    close: str
    end: int


_STATIC_IMPORT_RE = re.compile(
    rf"(?P<prefix>\b(?:import|export){_JS_TRIVIA_RE}"
    rf"(?:{_JS_IMPORT_CLAUSE_RE}\bfrom{_JS_TRIVIA_RE})?)"
    r"(?P<quote>[\"'])(?P<path>\.{1,2}/[^\"']+)(?P=quote)",
    re.S,
)
_DYNAMIC_IMPORT_RE = re.compile(
    rf"(?P<prefix>\bimport{_JS_TRIVIA_RE}\({_JS_TRIVIA_RE})"
    r"(?P<quote>[\"'])(?P<path>\.{1,2}/[^\"']+)(?P=quote)",
    re.S,
)


def normalize_files(
    files: Mapping[str, FileInput] | None,
    *,
    base_path: str | pathlib.Path | None,
) -> dict[str, FileAttachment]:
    """Normalize explicit attachment inputs for the frontend registry."""

    if not files:
        return {}
    base = pathlib.Path(base_path).expanduser().resolve() if base_path else None
    return {
        name: _normalize_file_info(name, value, base_path=base)
        for name, value in files.items()
    }


def prepare_source(
    source: str,
    *,
    base_path: str | pathlib.Path | None,
    embed: bool,
    rewrite_imports: bool,
) -> tuple[str, dict[str, FileAttachment]]:
    """Prepare Notebook Kit HTML and discovered attachments.

    ``embed`` discovers local ``FileAttachment`` files. ``rewrite_imports``
    rewrites relative JavaScript imports to data URLs. Either option needs a
    base path because the source string has no filesystem owner.
    """

    if (embed or rewrite_imports) and base_path is None:
        raise ValueError(
            "base_path is required when embedding files or rewriting imports"
        )
    if not embed and not rewrite_imports:
        return source, {}
    base = pathlib.Path(cast(str | pathlib.Path, base_path)).expanduser().resolve()
    attachments = _collect_attachments(source, base) if embed else {}
    if rewrite_imports:
        source = _embed_local_imports(source, base)
    return source, attachments


def _normalize_file_info(
    name: str,
    value: FileInput,
    *,
    base_path: pathlib.Path | None,
) -> FileAttachment:
    if isinstance(value, Mapping):
        mapping = cast(Mapping[str, object], value)
        url = mapping.get("url")
        if not isinstance(url, str):
            raise ValueError(f"file mapping for {name!r} must contain a string 'url'")
        return cast(
            FileAttachment,
            {
                key: mapping[key]
                for key in ("url", "mimeType", "lastModified", "size")
                if key in mapping
            },
        )
    if isinstance(value, str) and _is_url(value):
        return {"url": value, "mimeType": _guess_mime_type(name)}
    path = pathlib.Path(value).expanduser()
    if not path.is_absolute():
        path = (base_path or pathlib.Path.cwd()) / path
    return _file_info(name, path.resolve())


def _collect_attachments(
    source: str, base_path: pathlib.Path
) -> dict[str, FileAttachment]:
    attachments: dict[str, FileAttachment] = {}
    for script in _iter_notebook_script_blocks(source):
        if not _is_javascript_script(script.attrs):
            continue
        code_mask = _javascript_code_mask(script.body)
        names = {
            "FileAttachment",
            *_stdlib_file_attachment_aliases(script.body, code_mask),
        }
        for match in _file_attachment_call_re(names).finditer(script.body):
            if not code_mask[match.start()]:
                continue
            if not _has_bare_token_start(script.body, match.start(), code_mask):
                continue
            name = match.group("quoted") or match.group("template") or ""
            if _is_url(name) or name in attachments:
                continue
            path = (base_path / name).resolve()
            if path.is_file():
                attachments[name] = _file_info(name, path)
    return attachments


def _embed_local_imports(source: str, base_path: pathlib.Path) -> str:
    parts: list[str] = []
    cursor = 0
    for script in _iter_notebook_script_blocks(source):
        parts.append(source[cursor : script.start])
        if _is_javascript_script(script.attrs):
            body = _rewrite_import_specifiers(script.body, base_path)
            parts.append(f"{script.open}{body}{script.close}")
        else:
            parts.append(source[script.start : script.end])
        cursor = script.end
    parts.append(source[cursor:])
    return "".join(parts)


def _iter_notebook_script_blocks(source: str) -> list[_ScriptBlock]:
    parser = _NotebookScriptBlockParser(source)
    parser.feed(source)
    return parser.blocks


class _NotebookScriptBlockParser(HTMLParser):
    """Find script bodies inside the Notebook Kit ``<notebook>`` element."""

    def __init__(self, source: str) -> None:
        super().__init__(convert_charrefs=False)
        self.source = source
        self.blocks: list[_ScriptBlock] = []
        self._line_offsets = _line_offsets(source)
        self._notebook_depth = 0
        self._script: tuple[int, str, str, int] | None = None

    def handle_starttag(
        self,
        tag: str,
        attrs: list[tuple[str, str | None]],
    ) -> None:
        del attrs
        tag = tag.lower()
        if tag == "notebook" and self._script is None:
            self._notebook_depth += 1
            return
        if tag != "script" or not self._notebook_depth or self._script is not None:
            return
        start = self._offset()
        open_tag = self.get_starttag_text() or ""
        if not open_tag:
            return
        body_start = start + len(open_tag)
        self._script = (start, open_tag, _script_attrs_text(open_tag), body_start)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag == "script" and self._script is not None:
            close_start = self._offset()
            close_end = self.source.find(">", close_start)
            if close_end == -1:
                self._script = None
                return
            start, open_tag, attrs, body_start = self._script
            self.blocks.append(
                _ScriptBlock(
                    start=start,
                    open=open_tag,
                    attrs=attrs,
                    body_start=body_start,
                    body=self.source[body_start:close_start],
                    close=self.source[close_start : close_end + 1],
                    end=close_end + 1,
                )
            )
            self._script = None
            return
        if tag == "notebook" and self._script is None and self._notebook_depth:
            self._notebook_depth -= 1

    def _offset(self) -> int:
        line, column = self.getpos()
        return self._line_offsets[line - 1] + column


def _line_offsets(source: str) -> list[int]:
    offsets = [0]
    offsets.extend(match.end() for match in re.finditer("\n", source))
    return offsets


def _script_attrs_text(open_tag: str) -> str:
    end = -2 if open_tag.endswith("/>") else -1
    return open_tag[len("<script") : end]


def _is_javascript_script(attrs: str) -> bool:
    value = _script_attrs(attrs).get("type", "module")
    script_type = value.strip().lower()
    return script_type not in _NON_JAVASCRIPT_SCRIPT_TYPES


def _script_attrs(attrs: str) -> dict[str, str]:
    parser = _ScriptAttrParser()
    parser.feed(f"<script{attrs}></script>")
    return parser.attrs


class _ScriptAttrParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.attrs: dict[str, str] = {}

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "script":
            return
        self.attrs = {name.lower(): value or "" for name, value in attrs}


def _rewrite_import_specifiers(
    source: str,
    base_path: pathlib.Path,
    seen: frozenset[pathlib.Path] = frozenset(),
) -> str:
    """Inline relative JavaScript imports for source-backed notebook rendering."""

    def replace(
        match: re.Match[str],
        code_mask: list[bool],
        *,
        require_bare: bool = True,
    ) -> str:
        if not code_mask[match.start()]:
            return match.group(0)
        if require_bare and not _has_bare_token_start(
            source,
            match.start(),
            code_mask,
        ):
            return match.group(0)
        path = match.group("path")
        resolved = (base_path / path).resolve()
        if not resolved.is_file():
            return match.group(0)
        return f"{match.group('prefix')}{match.group('quote')}{_module_data_url(resolved, seen)}{match.group('quote')}"

    code_mask = _javascript_code_mask(source)
    source = _STATIC_IMPORT_RE.sub(lambda match: replace(match, code_mask), source)
    code_mask = _javascript_code_mask(source)
    return _DYNAMIC_IMPORT_RE.sub(lambda match: replace(match, code_mask), source)


def _file_attachment_call_re(names: set[str]) -> re.Pattern[str]:
    alternatives = "|".join(
        re.escape(name) for name in sorted(names, key=len, reverse=True)
    )
    return re.compile(
        rf"(?P<callee>{alternatives})(?![0-9A-Za-z_$]){_JS_TRIVIA_RE}"
        rf"\({_JS_TRIVIA_RE}{_FILE_ATTACHMENT_ARGUMENT_RE}{_JS_TRIVIA_RE}\)",
        re.S,
    )


def _stdlib_file_attachment_aliases(source: str, code_mask: list[bool]) -> set[str]:
    aliases: set[str] = set()
    for match in _STDLIB_IMPORT_RE.finditer(source):
        if not code_mask[match.start()]:
            continue
        for item in match.group("imports").split(","):
            parts = item.strip().split()
            if not parts or parts[0] != "FileAttachment":
                continue
            if len(parts) == 1:
                aliases.add("FileAttachment")
            elif (
                len(parts) == 3
                and parts[1] == "as"
                and re.fullmatch(
                    _JS_IDENTIFIER_RE,
                    parts[2],
                )
            ):
                aliases.add(parts[2])
    return aliases


def _javascript_code_mask(source: str) -> list[bool]:
    """Mark character positions that belong to executable JavaScript code."""

    mask = [True] * len(source)
    index = 0
    while index < len(source):
        char = source[index]
        next_char = source[index + 1] if index + 1 < len(source) else ""
        if char == "/" and next_char == "/":
            index = _mask_until(source, mask, index, "\n")
        elif char == "/" and next_char == "*":
            index = _mask_until(source, mask, index, "*/")
        elif char == "/" and _starts_regex_literal(source, index, mask):
            index = _mask_regex(source, mask, index)
        elif char == "`":
            index = _mask_template(source, mask, index)
        elif char in {"'", '"'}:
            index = _mask_string(source, mask, index, char)
        else:
            index += 1
    return mask


def _mask_until(source: str, mask: list[bool], start: int, marker: str) -> int:
    end = source.find(marker, start + len(marker))
    if end == -1:
        end = len(source)
    else:
        end += len(marker)
    for index in range(start, end):
        mask[index] = False
    return end


def _mask_string(source: str, mask: list[bool], start: int, quote: str) -> int:
    index = start
    escaped = False
    while index < len(source):
        mask[index] = False
        char = source[index]
        if escaped:
            escaped = False
        elif char == "\\":
            escaped = True
        elif char == quote and index != start:
            return index + 1
        index += 1
    return index


def _mask_template(source: str, mask: list[bool], start: int) -> int:
    index = start
    while index < len(source):
        mask[index] = False
        char = source[index]
        next_char = source[index + 1] if index + 1 < len(source) else ""
        if char == "\\":
            if index + 1 < len(source):
                mask[index + 1] = False
            index += 2
        elif char == "$" and next_char == "{":
            mask[index + 1] = False
            index = _mask_template_expression(source, mask, index + 2)
        elif char == "`" and index != start:
            return index + 1
        else:
            index += 1
    return index


def _mask_template_expression(source: str, mask: list[bool], start: int) -> int:
    depth = 1
    index = start
    while index < len(source):
        char = source[index]
        next_char = source[index + 1] if index + 1 < len(source) else ""
        if char == "/" and next_char == "/":
            index = _mask_until(source, mask, index, "\n")
        elif char == "/" and next_char == "*":
            index = _mask_until(source, mask, index, "*/")
        elif char == "/" and _starts_regex_literal(source, index, mask):
            index = _mask_regex(source, mask, index)
        elif char == "`":
            index = _mask_template(source, mask, index)
        elif char in {"'", '"'}:
            index = _mask_string(source, mask, index, char)
        elif char == "{":
            depth += 1
            index += 1
        elif char == "}":
            depth -= 1
            mask[index] = False
            index += 1
            if depth == 0:
                return index
        else:
            index += 1
    return index


def _starts_regex_literal(source: str, start: int, mask: list[bool]) -> bool:
    index = _previous_code_index(source, start, mask)
    if index < 0:
        return True
    if _is_js_identifier_part(source[index]):
        keyword, keyword_start = _identifier_ending_at(source, index)
        return keyword in _REGEX_PREFIX_KEYWORDS and _is_bare_keyword_start(
            source, keyword_start, mask
        )
    if source[index] == ")":
        open_paren = _matching_open_paren(source, index, mask)
        if open_paren is not None:
            keyword = _keyword_before(source, open_paren, mask)
            return keyword in _CONTROL_CONDITION_KEYWORDS
    return source[index] in "({[=,:;!&|?+-*~%^<>"


def _previous_code_index(source: str, start: int, mask: list[bool]) -> int:
    index = start - 1
    while index >= 0 and (source[index].isspace() or not mask[index]):
        index -= 1
    return index


def _identifier_ending_at(source: str, end_index: int) -> tuple[str, int]:
    start = end_index
    while start >= 0 and _is_js_identifier_part(source[start]):
        start -= 1
    return source[start + 1 : end_index + 1], start + 1


def _is_js_identifier_part(char: str) -> bool:
    return char == "$" or char == "_" or char.isidentifier() or char.isdigit()


def _matching_open_paren(
    source: str,
    close_paren: int,
    mask: list[bool],
) -> int | None:
    depth = 0
    index = close_paren
    while index >= 0:
        if not mask[index]:
            index -= 1
            continue
        if source[index] == ")":
            depth += 1
        elif source[index] == "(":
            depth -= 1
            if depth == 0:
                return index
        index -= 1
    return None


def _keyword_before(source: str, index: int, mask: list[bool]) -> str:
    keyword_end = _previous_code_index(source, index, mask)
    if keyword_end < 0 or not _is_js_identifier_part(source[keyword_end]):
        return ""
    keyword, keyword_start = _identifier_ending_at(source, keyword_end)
    if keyword == "await" and _keyword_before(source, keyword_start, mask) == "for":
        return "for"
    if not _is_bare_keyword_start(source, keyword_start, mask):
        return ""
    return keyword


def _is_bare_keyword_start(
    source: str,
    keyword_start: int,
    mask: list[bool],
) -> bool:
    before_keyword = _previous_code_index(source, keyword_start, mask)
    return before_keyword < 0 or (
        source[before_keyword] not in {".", "#"}
        and not _is_js_identifier_part(source[before_keyword])
    )


def _has_bare_token_start(
    source: str,
    token_start: int,
    mask: list[bool],
) -> bool:
    before = _previous_code_index(source, token_start, mask)
    if before < 0:
        return True
    if source[before] in {".", "#"}:
        return False
    return before != token_start - 1 or not _is_js_identifier_part(source[before])


def _mask_regex(source: str, mask: list[bool], start: int) -> int:
    index = start
    escaped = False
    in_character_class = False
    while index < len(source):
        mask[index] = False
        char = source[index]
        if escaped:
            escaped = False
        elif char == "\\":
            escaped = True
        elif char == "[":
            in_character_class = True
        elif char == "]":
            in_character_class = False
        elif char == "/" and index != start and not in_character_class:
            index += 1
            while index < len(source) and (
                source[index].isalpha() or source[index].isdigit()
            ):
                mask[index] = False
                index += 1
            return index
        index += 1
    return index


def _file_info(name: str, path: pathlib.Path) -> FileAttachment:
    return {
        "url": _data_url(path),
        "mimeType": _guess_mime_type(name),
        "size": path.stat().st_size,
    }


def _data_url(path: pathlib.Path) -> str:
    return _data_url_bytes(path.name, path.read_bytes())


def _module_data_url(path: pathlib.Path, seen: frozenset[pathlib.Path]) -> str:
    path = path.resolve()
    if path in seen:
        raise ValueError(f"Circular local JavaScript import: {path}")
    source = path.read_text(encoding="utf-8")
    source = _rewrite_import_specifiers(source, path.parent, seen | frozenset((path,)))
    return _data_url_bytes(path.name, source.encode("utf-8"))


def _data_url_bytes(name: str, data: bytes) -> str:
    encoded = base64.b64encode(data).decode("ascii")
    return f"data:{_guess_mime_type(name)};base64,{encoded}"


def _guess_mime_type(name: str) -> str:
    custom = {
        ".arrow": "application/vnd.apache.arrow.file",
        ".parquet": "application/vnd.apache.parquet",
    }
    suffix = pathlib.PurePosixPath(name).suffix.lower()
    return (
        custom.get(suffix)
        or mimetypes.guess_type(name)[0]
        or "application/octet-stream"
    )


def _is_url(value: str) -> bool:
    # A drive letter satisfies URI scheme grammar but names a local Windows path.
    if re.match(r"^[a-zA-Z]:", value):
        return False
    return bool(re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", value))
