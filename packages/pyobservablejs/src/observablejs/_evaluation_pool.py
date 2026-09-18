"""Selection-scoped execution reuse and cancellable resource acquisition."""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Callable, Sequence
from contextlib import suppress
from typing import TYPE_CHECKING, Literal

from . import errors

if TYPE_CHECKING:
    from ._execution import Evaluation
    from ._notebook import Notebook


class _Acquisition:
    """Hand off a newly constructed resource before its blocking startup."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cancelled = False
        self._session: Evaluation | None = None

    def track(self, session: Evaluation) -> None:
        with self._lock:
            self._session = session
            cancelled = self._cancelled
        if cancelled:
            session.close()
            raise errors.ViewClosedError("Notebook execution acquisition was cancelled")

    def cancel(self) -> Evaluation | None:
        with self._lock:
            self._cancelled = True
            return self._session


class _EvaluationPool:
    """One execution configuration shared by a notebook's scoped namespaces."""

    def __init__(
        self,
        notebook: Notebook,
        engine: Literal["deno", "chromium"],
        network: bool | Sequence[str],
        resolve_notebook: Callable[[str], Notebook] | None,
    ) -> None:
        self._notebook = notebook
        self._engine = engine
        self._network = network
        self._resolve_notebook = resolve_notebook
        self._lock = threading.RLock()
        self._sessions: dict[tuple[int, ...], Evaluation] = {}

    def acquire(
        self,
        indexes: tuple[int, ...],
        timeout: float | None,
        *,
        reuse_enclosing: bool = False,
        _acquisition: _Acquisition | None = None,
    ) -> Evaluation:
        with self._lock:
            notebook = self._notebook
            notebook._controller._require_open()
            indexes = indexes or tuple(range(len(notebook.cells)))
            for selection, session in tuple(self._sessions.items()):
                if session._closed or session._spec is not notebook._controller._spec:
                    session.close()
                    del self._sessions[selection]
            if indexes in self._sessions:
                return self._sessions[indexes]
            # Discovery needs its exact catalog scope; reads can reuse an
            # already running superset without executing additional cells.
            if reuse_enclosing:
                requested = set(indexes)
                enclosing = [
                    selection
                    for selection in self._sessions
                    if requested.issubset(selection)
                ]
                if enclosing:
                    return self._sessions[min(enclosing, key=len)]
            from ._execution import Evaluation

            session = Evaluation(
                notebook,
                [notebook._cell_at(index) for index in indexes],
                engine=self._engine,
                network=self._network,
                resolve_notebook=self._resolve_notebook,
                timeout=timeout,
            )
            if _acquisition is not None:
                _acquisition.track(session)
            session.open()
            self._sessions[indexes] = session
            return session

    async def acquire_async(
        self,
        indexes: tuple[int, ...],
        timeout: float | None,
        *,
        reuse_enclosing: bool = False,
    ) -> Evaluation:
        acquisition = _Acquisition()
        worker = asyncio.create_task(
            asyncio.to_thread(
                self.acquire,
                indexes,
                timeout,
                reuse_enclosing=reuse_enclosing,
                _acquisition=acquisition,
            )
        )
        try:
            return await asyncio.shield(worker)
        except asyncio.CancelledError:
            session = acquisition.cancel()
            if session is not None:
                await asyncio.to_thread(session.close)
            # Join the worker: no late publication or executor work survives the
            # cancelled acquisition, including cancellation before construction.
            with suppress(Exception):
                await worker
            raise
