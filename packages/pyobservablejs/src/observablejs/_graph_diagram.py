"""Shared diagram model for synced notebook dependency graphs."""

from __future__ import annotations

import dataclasses
import json
from collections.abc import Sequence
from typing import Protocol


class _Cell(Protocol):
    @property
    def id(self) -> int: ...

    @property
    def index(self) -> int: ...

    @property
    def mode(self) -> str: ...

    @property
    def key(self) -> str | None: ...

    @property
    def defines(self) -> tuple[str, ...]: ...

    @property
    def references(self) -> tuple[str, ...]: ...

    @property
    def output(self) -> str | None: ...


class _Edge(Protocol):
    @property
    def source(self) -> _Cell: ...

    @property
    def target(self) -> _Cell: ...

    @property
    def variable(self) -> str: ...


class _Graph(Protocol):
    @property
    def cells(self) -> Sequence[_Cell]: ...

    @property
    def edges(self) -> Sequence[_Edge]: ...

    @property
    def external_references(self) -> tuple[str, ...]: ...


@dataclasses.dataclass(frozen=True)
class _DiagramNode:
    node_id: str
    label: str


@dataclasses.dataclass(frozen=True)
class _DiagramEdge:
    source_id: str
    target_id: str
    label: str


@dataclasses.dataclass(frozen=True)
class _Diagram:
    nodes: tuple[_DiagramNode, ...]
    edges: tuple[_DiagramEdge, ...]


def _diagram_from_graph(graph: _Graph) -> _Diagram:
    cell_ids = _cell_node_ids(graph.cells)
    external_ids = _external_node_ids(graph.external_references)

    nodes = [_DiagramNode(cell_ids[cell.id], _cell_label(cell)) for cell in graph.cells]
    nodes.extend(
        _DiagramNode(node_id, f"external: {name}")
        for name, node_id in external_ids.items()
    )

    edges: list[_DiagramEdge] = []
    for edge in graph.edges:
        source = cell_ids.get(edge.source.id)
        target = cell_ids.get(edge.target.id)
        if source is not None and target is not None:
            edges.append(_DiagramEdge(source, target, edge.variable))

    edges.extend(_external_edges(graph, cell_ids, external_ids))

    return _Diagram(nodes=tuple(nodes), edges=tuple(edges))


def graph_to_mermaid(graph: _Graph) -> str:
    """Return Mermaid flowchart syntax for ``graph``.

    Format reference: https://mermaid.js.org/syntax/flowchart.html
    """

    diagram = _diagram_from_graph(graph)
    lines = ["flowchart LR"]

    for node in diagram.nodes:
        lines.append(f'  {node.node_id}["{_mermaid_text(node.label)}"]')

    for edge in diagram.edges:
        lines.append(
            f"  {edge.source_id} -->|{_mermaid_text(edge.label)}| {edge.target_id}"
        )

    return "\n".join(lines) + "\n"


def graph_to_d2(graph: _Graph) -> str:
    """Return D2 diagram syntax for ``graph``.

    Format reference: https://d2lang.com/tour/connections/
    String reference: https://d2lang.com/tour/strings/
    """

    diagram = _diagram_from_graph(graph)
    lines = ["direction: right"]

    for node in diagram.nodes:
        lines.append(f"{node.node_id}: {_d2_string(node.label)}")

    for edge in diagram.edges:
        lines.append(f"{edge.source_id} -> {edge.target_id}: {_d2_string(edge.label)}")

    return "\n".join(lines) + "\n"


def _cell_node_ids(cells: Sequence[_Cell]) -> dict[int, str]:
    node_ids: dict[int, str] = {}
    for position, cell in enumerate(cells):
        node_ids.setdefault(cell.id, f"cell_{position}")
    return node_ids


def _external_node_ids(references: Sequence[str]) -> dict[str, str]:
    return {name: f"external_{position}" for position, name in enumerate(references)}


def _external_edges(
    graph: _Graph,
    cell_ids: dict[int, str],
    external_ids: dict[str, str],
) -> tuple[_DiagramEdge, ...]:
    edges: list[_DiagramEdge] = []
    emitted: set[tuple[str, int]] = set()
    for cell in graph.cells:
        target = cell_ids.get(cell.id)
        if target is None:
            continue
        for name in cell.references:
            source = external_ids.get(name)
            if source is not None and (name, cell.id) not in emitted:
                edges.append(_DiagramEdge(source, target, name))
                emitted.add((name, cell.id))
    return tuple(edges)


def _cell_label(cell: _Cell) -> str:
    title = cell.key or f"Cell {cell.index}"
    parts = [title]
    if cell.defines:
        parts.append(f"defines: {', '.join(cell.defines)}")
    return ", ".join(parts)


def _inline_text(value: str) -> str:
    return " ".join(value.split())


def _mermaid_text(value: str) -> str:
    return "".join(
        _MERMAID_ENTITIES.get(character, character) for character in _inline_text(value)
    )


def _d2_string(value: str) -> str:
    return json.dumps(_inline_text(value))


_MERMAID_ENTITIES = {
    '"': "#quot;",
    "#": "#35;",
    "&": "#38;",
    "<": "#60;",
    ">": "#62;",
    "|": "#124;",
    "`": "#96;",
}
