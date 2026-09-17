"""Notebook state and mutation semantics, independent of evaluation transports."""

from __future__ import annotations

import weakref
from collections.abc import Iterable, Mapping
from typing import Any, Protocol, cast

import traitlets

from ._files import FileAttachment
from ._model import NotebookModel
from ._serialize import serialize
from ._themes import normalize_theme
from ._variables import (
    OBSERVABLE_RESERVED_VARIABLE_NAMES,
    prepare_variables,
    same_wire_value,
    validate_variable_name,
)
from .types import Theme

_MISSING_VARIABLE = object()


class Closable(Protocol):
    def close(self) -> None: ...


class NotebookController(traitlets.HasTraits):
    """Transport-independent notebook definition and mutable controller state."""

    _source = traitlets.Unicode("")
    _spec = traitlets.Dict()
    theme = traitlets.Any(default_value="air")
    _attachments = traitlets.Dict()
    _base_url = traitlets.Unicode("")
    _variables = traitlets.Dict(default_value={})
    _variable_update = traitlets.Dict(default_value={})
    _view_values = traitlets.Dict(default_value={})
    _options = traitlets.Dict()
    _cell_keys = traitlets.List(traitlets.Unicode(), default_value=[])

    def __init__(
        self,
        model: NotebookModel,
        *,
        variables: Mapping[str, Any] | None,
        show_pinned_source: bool,
    ) -> None:
        self._reserved_variable_names = (
            OBSERVABLE_RESERVED_VARIABLE_NAMES
            if model.runtime_profile == "observable"
            else frozenset()
        )
        self._variable_values, variable_wire = self._prepare_variables(variables)
        self._cell_ids = tuple(node.id for node in model.nodes)
        self._resources: weakref.WeakSet[Closable] = weakref.WeakSet()
        self._notebook_closed = False
        self._variable_update_seq = 0
        spec = dict(model.spec)
        if not model.source:
            spec["theme"] = model.theme
            spec["cells"] = [
                {**node.to_spec(), "pinned": node.pinned} for node in model.nodes
            ]
        self._initializing_notebook = True
        try:
            super().__init__(
                _source=model.source,
                _spec=spec,
                theme=model.theme,
                _attachments=dict(model.attachments),
                _variables=variable_wire,
                _options={"show_source": show_pinned_source},
                _cell_keys=list(model.cell_keys),
            )
        finally:
            self._initializing_notebook = False

    @traitlets.validate("theme")
    def _validate_theme(self, proposal: Any) -> Theme:
        self._require_open()
        theme = normalize_theme(proposal["value"])
        if (
            not getattr(self, "_initializing_notebook", False)
            and getattr(self, "_source", "")
            and theme != self.theme
        ):
            raise traitlets.TraitError(
                "source-backed notebook themes are defined by the source HTML"
            )
        return theme

    @traitlets.observe("theme")
    def _sync_theme_to_spec(self, change: Any) -> None:
        if getattr(self, "_initializing_notebook", False) or self._source:
            return
        spec = dict(self._spec)
        spec["theme"] = change["new"]
        self.set_trait("_spec", spec)

    @property
    def variables(self) -> dict[str, Any]:
        return dict(self._variable_values)

    @property
    def attachments(self) -> dict[str, FileAttachment]:
        return cast(dict[str, FileAttachment], dict(self._attachments))

    def update_variables(
        self,
        values: Mapping[str, object],
        /,
    ) -> bool:
        self._require_open()
        if not isinstance(values, Mapping):
            raise TypeError("update_variables expects one mapping")
        return bool(values) and self._patch_variables(values)

    def replace_variables(
        self,
        values: Mapping[str, object],
        /,
    ) -> bool:
        self._require_open()
        if not isinstance(values, Mapping):
            raise TypeError("replace_variables expects one mapping")
        prepared, serialized = self._prepare_variables(values)
        return self._apply_variable_replacement(prepared, serialized)

    def reset_variables(self, *names: str) -> bool:
        self._require_open()
        if not names:
            return False
        validated_names = tuple(self._validate_variable_name(name) for name in names)
        values = dict(self._variable_values)
        serialized = dict(self._variables)
        changed = False
        for name in validated_names:
            if name in values:
                del values[name]
                serialized.pop(name, None)
                changed = True
        if changed:
            return self._apply_variable_replacement(values, serialized)
        return False

    def _require_open(self) -> None:
        if self._notebook_closed:
            raise RuntimeError("Cannot mutate a closed Notebook")

    def _patch_variables(self, updates: Mapping[str, Any]) -> bool:
        prepared_updates, serialized_updates = self._prepare_variables(updates)
        cleared_view_names = set(serialized_updates).intersection(self._view_values)
        changed = {
            name: value
            for name, value in prepared_updates.items()
            if name in cleared_view_names
            or not same_wire_value(
                self._variables.get(name, _MISSING_VARIABLE), serialized_updates[name]
            )
        }
        if not changed:
            return False
        changed_wire = {name: serialized_updates[name] for name in changed}
        self._variable_values = {**self._variable_values, **changed}
        self._variable_update_seq += 1
        with self.hold_trait_notifications():
            self._clear_view_values(serialized_updates)
            self.set_trait("_variables", {**self._variables, **changed_wire})
            self.set_trait(
                "_variable_update",
                {
                    "seq": self._variable_update_seq,
                    "kind": "set",
                    "values": changed_wire,
                },
            )
        return True

    def _prepare_variables(
        self, values: Mapping[str, Any] | None
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        return prepare_variables(values, reserved_names=self._reserved_variable_names)

    def _validate_variable_name(self, name: object) -> str:
        return validate_variable_name(
            name,
            reserved_names=self._reserved_variable_names,
        )

    def _apply_variable_replacement(
        self,
        values: Mapping[str, Any],
        serialized: Mapping[str, Any],
    ) -> bool:
        python_names = set(self._variable_values).union(serialized)
        cleared_view_names = python_names.intersection(self._view_values)
        if same_wire_value(self._variables, serialized) and not cleared_view_names:
            return False
        self._variable_values = dict(values)
        wire = dict(serialized)
        self._variable_update_seq += 1
        with self.hold_trait_notifications():
            self._clear_view_values(python_names)
            self.set_trait("_variables", wire)
            self.set_trait(
                "_variable_update",
                {
                    "seq": self._variable_update_seq,
                    "kind": "replace",
                    "values": wire,
                },
            )
        return True

    def _clear_view_values(self, names: Iterable[str]) -> set[str]:
        cleared_names = set(names).intersection(self._view_values)
        if cleared_names:
            self.set_trait(
                "_view_values",
                {
                    name: value
                    for name, value in self._view_values.items()
                    if name not in cleared_names
                },
            )
        return cleared_names

    def to_notebook_html(self) -> str:
        return self._source or serialize(self._spec)

    def close(self) -> None:
        if getattr(self, "_notebook_closed", False):
            return
        self._notebook_closed = True
        for resource in tuple(getattr(self, "_resources", ())):
            resource.close()
