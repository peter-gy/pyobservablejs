"""Actionable declared files, independent of the optional headless engine."""

from __future__ import annotations

import asyncio
import gzip
import urllib.request
import zlib
from collections.abc import Iterator, Mapping
from typing import TYPE_CHECKING, Any

from . import _conversions as convert

if TYPE_CHECKING:
    import pandas
    import polars
    import pyarrow

    from ._notebook import Notebook
    from ._view import NotebookView


class FileReference:
    def __init__(self, notebook: Notebook, name: str) -> None:
        self._notebook = notebook
        self.name = name

    def _record(self) -> Mapping[str, Any]:
        declared = self._notebook.state.attachments.get(self.name)
        if declared is not None:
            return declared
        inspection = self._notebook._analysis_cache
        if inspection is not None:
            for file in inspection.attachments:
                if file.name == self.name:
                    return {
                        "url": file.url,
                        "mimeType": file.mime_type,
                        "size": file.size,
                    }
        raise KeyError(self.name)

    @property
    def url(self) -> str | None:
        return self._record()["url"]

    @property
    def mime_type(self) -> str | None:
        return self._record().get("mimeType")

    @property
    def size(self) -> int | None:
        return self._record().get("size")

    def read_bytes(self, *, timeout: float | None = 30) -> bytes:
        self._notebook._controller._require_open()
        url = self.url
        if url is None:
            raise ValueError(
                "The file URL is unresolved; read it through a displayed view.files reference"
            )
        with urllib.request.urlopen(url, timeout=timeout) as response:
            data = response.read()
            encodings = response.headers.get("Content-Encoding", "").split(",")
            for encoding in reversed(encodings):
                match encoding.strip().lower():
                    case "gzip" | "x-gzip":
                        data = gzip.decompress(data)
                    case "deflate":
                        data = zlib.decompress(data)
                    case "" | "identity":
                        pass
                    case _:
                        raise ValueError(
                            f"Unsupported attachment content encoding: {encoding}"
                        )
            return data

    def _load(self, format: str | None, timeout: float | None) -> tuple[bytes, str]:
        data = self.read_bytes(timeout=timeout)
        return data, convert.file_format(self.name, self.mime_type, data, format)

    def to_python(
        self, *, format: str | None = None, timeout: float | None = 30
    ) -> object:
        return convert.file_python(*self._load(format, timeout))

    def to_polars(
        self, *, format: str | None = None, timeout: float | None = 30
    ) -> polars.DataFrame:
        convert.require_library("polars")
        return convert.file_polars(*self._load(format, timeout))

    def to_pandas(
        self, *, format: str | None = None, timeout: float | None = 30
    ) -> pandas.DataFrame:
        convert.require_library("pandas", "pyarrow")
        return convert.file_pandas(*self._load(format, timeout))

    def to_arrow(
        self, *, format: str | None = None, timeout: float | None = 30
    ) -> pyarrow.Table:
        convert.require_library("pyarrow")
        return convert.file_arrow(*self._load(format, timeout))

    def __repr__(self) -> str:
        return f"FileReference({self.name!r})"


class Files(Mapping[str, FileReference]):
    def __init__(self, notebook: Notebook) -> None:
        self._notebook = notebook

    @property
    def aio(self) -> AsyncFiles:
        return AsyncFiles(self._notebook)

    def __getitem__(self, name: str) -> FileReference:
        if name not in self:
            raise KeyError(name)
        return FileReference(self._notebook, name)

    def __iter__(self) -> Iterator[str]:
        inspection = self._notebook._analysis_cache
        return iter(
            dict.fromkeys(
                [
                    *self._notebook.state.attachments,
                    *(
                        [file.name for file in inspection.attachments]
                        if inspection
                        else []
                    ),
                ]
            )
        )

    def __contains__(self, name: object) -> bool:
        return name in tuple(iter(self))

    def __len__(self) -> int:
        return sum(1 for _ in self)


class AsyncFileReference:
    def __init__(self, file: FileReference, view: NotebookView | None = None) -> None:
        self._view = view
        self._file = file
        self.name = file.name

    @property
    def url(self) -> str | None:
        return self._file.url

    @property
    def mime_type(self) -> str | None:
        return self._file.mime_type

    @property
    def size(self) -> int | None:
        return self._file.size

    async def read_bytes(self, *, timeout: float | None = 30) -> bytes:
        if self._view is not None:
            return await self._view._read_attachment(self.name, timeout=timeout)
        return await asyncio.to_thread(self._file.read_bytes, timeout=timeout)

    async def _load(
        self, format: str | None, timeout: float | None
    ) -> tuple[bytes, str]:
        data = await self.read_bytes(timeout=timeout)
        resolved_format = await asyncio.to_thread(
            convert.file_format, self.name, self.mime_type, data, format
        )
        return data, resolved_format

    async def to_python(
        self, *, format: str | None = None, timeout: float | None = 30
    ) -> object:
        data, resolved_format = await self._load(format, timeout)
        return await asyncio.to_thread(convert.file_python, data, resolved_format)

    async def to_polars(
        self, *, format: str | None = None, timeout: float | None = 30
    ) -> polars.DataFrame:
        convert.require_library("polars")
        data, resolved_format = await self._load(format, timeout)
        return await asyncio.to_thread(convert.file_polars, data, resolved_format)

    async def to_pandas(
        self, *, format: str | None = None, timeout: float | None = 30
    ) -> pandas.DataFrame:
        convert.require_library("pandas", "pyarrow")
        data, resolved_format = await self._load(format, timeout)
        return await asyncio.to_thread(convert.file_pandas, data, resolved_format)

    async def to_arrow(
        self, *, format: str | None = None, timeout: float | None = 30
    ) -> pyarrow.Table:
        convert.require_library("pyarrow")
        data, resolved_format = await self._load(format, timeout)
        return await asyncio.to_thread(convert.file_arrow, data, resolved_format)

    def __repr__(self) -> str:
        return f"AsyncFileReference({self.name!r})"


class AsyncFiles(Mapping[str, AsyncFileReference]):
    def __init__(self, notebook: Notebook, view: NotebookView | None = None) -> None:
        self._notebook = notebook
        self._view = view

    def __getitem__(self, name: str) -> AsyncFileReference:
        if name not in self._notebook.files:
            raise KeyError(name)
        return AsyncFileReference(FileReference(self._notebook, name), self._view)

    def __iter__(self) -> Iterator[str]:
        return iter(self._notebook.files)

    def __len__(self) -> int:
        return len(self._notebook.files)
