"""Exceptions and immutable diagnostics from notebook execution."""

from __future__ import annotations

import dataclasses
from collections.abc import Mapping, Sequence
from typing import Any, Literal, cast

import traitlets

Origin = Literal["notebook", "runtime", "widget"]
Phase = Literal["analysis", "evaluation", "rendering", "serialization", "transport"]


@dataclasses.dataclass(frozen=True)
class ErrorDetail:
    name: str
    message: str
    stack: str | None = None
    cause: ErrorDetail | None = None


@dataclasses.dataclass(frozen=True)
class DiagnosticCell:
    index: int
    id: int
    key: str
    mode: str
    source: str


@dataclasses.dataclass(frozen=True)
class Diagnostic:
    name: str
    message: str
    origin: Origin
    phase: Phase
    component: str
    operation: str
    stack: str | None = None
    cause: ErrorDetail | None = None
    variable: str | None = None
    cell: DiagnosticCell | None = None


class ObservableError(RuntimeError):
    """A notebook operation failed with structured diagnostic context."""

    def __init__(
        self, message: str = "", *, diagnostics: Sequence[Diagnostic] = ()
    ) -> None:
        self.diagnostics = tuple(diagnostics)
        details = "\n\n".join(_format_diagnostic(item) for item in self.diagnostics)
        super().__init__("\n\n".join(part for part in (message, details) if part))


def _format_diagnostic(diagnostic: Diagnostic) -> str:
    lines = [
        f"{diagnostic.name}: {diagnostic.message}",
        f"Origin: {diagnostic.origin}, phase: {diagnostic.phase}",
        f"Component: {diagnostic.component}",
        f"Operation: {diagnostic.operation}",
    ]
    if diagnostic.variable is not None:
        lines.append(f"Variable: {diagnostic.variable}")
    if diagnostic.cell is not None:
        cell = diagnostic.cell
        lines.append(
            f"Cell: {cell.key or '(anonymous)'} (index={cell.index}, id={cell.id}, mode={cell.mode})"
        )
        if cell.source:
            lines.append("Cell source (relative lines):")
            lines.extend(
                f"{index:>4} | {line}"
                for index, line in enumerate(cell.source.splitlines(), 1)
            )
    if diagnostic.stack:
        lines.extend(("Browser stack:", diagnostic.stack))
    cause = diagnostic.cause
    while cause is not None:
        lines.append(f"Caused by {cause.name}: {cause.message}")
        if cause.stack:
            lines.append(cause.stack)
        cause = cause.cause
    return "\n".join(lines)


class NotebookError(ObservableError):
    """Authored notebook source failed analysis or evaluation."""


class WidgetError(ObservableError):
    """Notebook runtime or widget infrastructure failed."""


class SerializationError(ObservableError):
    """A browser value could not be serialized for Python."""


class ReadError(ObservableError):
    """An explicit browser data read failed."""


class ProtocolError(WidgetError, traitlets.TraitError, ValueError):
    """A browser message violated the notebook transport contract."""


class ViewClosedError(ObservableError):
    """The view closed before the requested operation completed."""


class StaleViewError(ObservableError):
    """The runtime changed while an operation or descriptor was pending."""


class NotebookTimeoutError(ObservableError, TimeoutError):
    """The operation exceeded its requested timeout."""


def _is_fatal(diagnostic: Diagnostic) -> bool:
    return diagnostic.origin in {"runtime", "widget"} or diagnostic.phase in {
        "serialization",
        "transport",
    }


def _exception_for(
    diagnostics: Sequence[Diagnostic], *, read: bool = False
) -> ObservableError:
    entries = tuple(diagnostics)
    if not entries:
        raise ValueError("An exception requires at least one diagnostic")
    named = {
        "ViewClosedError": ViewClosedError,
        "StaleViewError": StaleViewError,
        "ProtocolError": ProtocolError,
        "NotebookTimeoutError": NotebookTimeoutError,
        "TimeoutError": NotebookTimeoutError,
    }
    primary = next((item for item in entries if _is_fatal(item)), entries[0])
    if primary.origin == "notebook":
        exception = NotebookError
    elif primary.origin == "runtime":
        exception = WidgetError
    elif primary.phase == "serialization":
        exception = SerializationError
    elif primary.phase == "transport" and primary.name in named:
        exception = named[primary.name]
    elif read:
        exception = ReadError
    else:
        exception = WidgetError
    return exception(diagnostics=entries)


def _object(value: object, required: set[str], optional: set[str]) -> Mapping[str, Any]:
    if (
        not isinstance(value, Mapping)
        or not required <= set(value)
        or set(value) - required - optional
    ):
        raise ValueError("Invalid diagnostic object shape")
    return cast(Mapping[str, Any], value)


def _string(value: object) -> str:
    if not isinstance(value, str):
        raise TypeError("Diagnostic fields must be strings")
    return value


def _error_detail(value: object, depth: int = 0) -> ErrorDetail:
    if depth > 8:
        raise ValueError("Diagnostic cause nesting exceeds the supported depth")
    raw = _object(value, {"name", "message"}, {"stack", "cause"})
    return ErrorDetail(
        _string(raw["name"]),
        _string(raw["message"]),
        _string(raw["stack"]) if "stack" in raw else None,
        _error_detail(raw["cause"], depth + 1) if "cause" in raw else None,
    )


def _diagnostic_cell(value: object) -> DiagnosticCell:
    raw = _object(value, {"index", "id", "key", "mode", "source"}, set())
    if type(raw["index"]) is not int or not 0 <= raw["index"] <= (1 << 53) - 1:
        raise ValueError("Diagnostic cell index must be a nonnegative safe integer")
    if type(raw["id"]) is not int or not 1 <= raw["id"] <= (1 << 53) - 1:
        raise ValueError("Diagnostic cell id must be a positive safe integer")
    return DiagnosticCell(
        raw["index"],
        raw["id"],
        _string(raw["key"]),
        _string(raw["mode"]),
        _string(raw["source"]),
    )


def _diagnostic_from_wire(value: object) -> Diagnostic:
    raw = _object(
        value,
        {"name", "message", "origin", "phase", "component", "operation"},
        {"stack", "cause", "variable", "cell"},
    )
    if raw["origin"] not in {"notebook", "runtime", "widget"}:
        raise ValueError("Invalid diagnostic origin")
    if raw["phase"] not in {
        "analysis",
        "evaluation",
        "rendering",
        "serialization",
        "transport",
    }:
        raise ValueError("Invalid diagnostic phase")
    return Diagnostic(
        _string(raw["name"]),
        _string(raw["message"]),
        cast(Origin, raw["origin"]),
        cast(Phase, raw["phase"]),
        _string(raw["component"]),
        _string(raw["operation"]),
        _string(raw["stack"]) if "stack" in raw else None,
        _error_detail(raw["cause"]) if "cause" in raw else None,
        _string(raw["variable"]) if "variable" in raw else None,
        _diagnostic_cell(raw["cell"]) if "cell" in raw else None,
    )


__all__ = [
    "Diagnostic",
    "DiagnosticCell",
    "ErrorDetail",
    "NotebookError",
    "NotebookTimeoutError",
    "ObservableError",
    "ProtocolError",
    "ReadError",
    "SerializationError",
    "StaleViewError",
    "ViewClosedError",
    "WidgetError",
]


def __dir__() -> list[str]:
    return sorted(__all__)
