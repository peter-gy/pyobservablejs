"""Shared data descriptions and actionable discovery catalogs."""

from __future__ import annotations

from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from types import MappingProxyType
from typing import TYPE_CHECKING, Generic, Literal, Protocol, TypeVar, overload

from . import errors
from ._graph import dependency_indexes
from ._inspection import DatasetDescription, NotebookInspection, _dataset, _object

if TYPE_CHECKING:
    from ._notebook import NotebookCell


@dataclass(frozen=True)
class DataSource:
    kind: Literal["file", "url"]
    name: str | None
    url: str | None
    provenance: Literal["static", "observed"] = "static"


@dataclass(frozen=True)
class DataDescription:
    kind: str
    schema: Mapping[str, str]
    row_count: int | None
    schema_source: Literal["native", "sampled"] | None
    sampled_rows: int = 0


def dataset_description(value: DatasetDescription) -> DataDescription:
    return DataDescription(
        value.kind,
        MappingProxyType({column.name: column.type for column in value.columns}),
        value.row_count,
        value.schema_source,
        value.sampled_rows,
    )


def decode_description(value: object) -> DataDescription:
    raw = _object(value, {"kind", "dataset"})
    if not isinstance(raw["kind"], str):
        raise errors.ProtocolError("Invalid data description")
    if raw["dataset"] is not None:
        return dataset_description(_dataset(raw["dataset"]))
    return DataDescription(raw["kind"], MappingProxyType({}), None, None)


class NamedReference(Protocol):
    @property
    def name(self) -> str | None: ...


Reference_co = TypeVar("Reference_co", bound=NamedReference, covariant=True)


class DatasetCollection(Sequence[Reference_co], Generic[Reference_co]):
    def __init__(self, values: Sequence[Reference_co]) -> None:
        self._values = tuple(values)

    @overload
    def __getitem__(self, key: str | int) -> Reference_co: ...
    @overload
    def __getitem__(self, key: slice) -> tuple[Reference_co, ...]: ...
    def __getitem__(
        self, key: str | int | slice
    ) -> Reference_co | tuple[Reference_co, ...]:
        if isinstance(key, str):
            matches = [value for value in self._values if value.name == key]
            if len(matches) != 1:
                raise KeyError(
                    f"Dataset name {key!r} is {'ambiguous' if matches else 'unknown'}"
                )
            return matches[0]
        return self._values[key]

    def __len__(self) -> int:
        return len(self._values)

    def __iter__(self) -> Iterator[Reference_co]:
        return iter(self._values)

    def __repr__(self) -> str:
        return f"Datasets({self.keys()!r})"

    def keys(self) -> tuple[str, ...]:
        return tuple(value.name for value in self._values if value.name is not None)


@dataclass(frozen=True)
class DataCatalog(Generic[Reference_co]):
    datasets: DatasetCollection[Reference_co]
    errors: tuple[errors.Diagnostic, ...]
    pending: bool = False


def variable_cell(
    inspection: NotebookInspection, name: str, scope: int | None = None
) -> NotebookCell:
    candidates = [
        cell.cell
        for cell in inspection.cells
        if name in cell.defines and (scope is None or cell.index == scope)
    ]
    if len(candidates) != 1:
        raise KeyError(
            f"Variable {name!r} is {'ambiguous; select its cell' if candidates else 'not defined'}"
        )
    return candidates[0]


def sources_for(inspection: NotebookInspection, index: int) -> tuple[DataSource, ...]:
    indexes = {index, *dependency_indexes(inspection.graph, index)}
    files = {file.name: file for file in inspection.attachments}
    names = dict.fromkeys(
        name
        for cell in inspection.cells
        if cell.index in indexes
        for name in cell.files
    )
    sources = [
        DataSource("file", name, files[name].url if name in files else None)
        for name in names
    ]
    sources.extend(
        DataSource("url", None, url)
        for cell in inspection.cells
        if cell.index in indexes
        for url in cell.urls
    )
    return tuple(dict.fromkeys(sources))
