"""Lazy anywidget transport for controller state shared by browser views."""

from __future__ import annotations

from typing import Any

import anywidget
import traitlets

from ._controller import NotebookController
from ._imports import NotebookImports


class _NotebookSession(anywidget.AnyWidget):
    _esm = "export default { initialize() {} };"
    _model_role = traitlets.Unicode("session").tag(sync=True)
    _source = traitlets.Unicode("").tag(sync=True)
    _spec = traitlets.Dict().tag(sync=True)
    theme = traitlets.Any(default_value="air").tag(sync=True)
    _attachments = traitlets.Dict().tag(sync=True)
    _base_url = traitlets.Unicode("").tag(sync=True)
    _variables = traitlets.Dict().tag(sync=True)
    _variable_update = traitlets.Dict().tag(sync=True)
    _view_values = traitlets.Dict().tag(sync=True)
    _options = traitlets.Dict().tag(sync=True)
    _cell_keys = traitlets.List(traitlets.Unicode()).tag(sync=True)

    def __init__(self, controller: NotebookController) -> None:
        self._controller = controller
        self._closed = False
        names = tuple(
            name for name in self.traits(sync=True) if name in controller.traits()
        )
        super().__init__(**{name: getattr(controller, name) for name in names})
        self._names = names
        controller.observe(self._publish, names=names)
        self.observe(self._inputs, names="_view_values")
        self._imports = NotebookImports(self)

    def _publish(self, change: Any) -> None:
        if self._closed:
            return
        changed = {
            name: getattr(self._controller, name)
            for name in self._names
            if getattr(self, name) != getattr(self._controller, name)
        }
        if changed:
            with self.hold_sync():
                for name, value in changed.items():
                    self.set_trait(name, value)

    def _inputs(self, change: Any) -> None:
        if not self._closed:
            self._controller.set_trait("_view_values", change["new"])

    def close(self) -> None:
        if getattr(self, "_closed", True):
            return
        self._closed = True
        self._controller.unobserve(self._publish, names=self._names)
        self.unobserve(self._inputs, names="_view_values")
        self._imports.close()
        super().close()
