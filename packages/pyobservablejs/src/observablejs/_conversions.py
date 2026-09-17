"""Optional Python data libraries and explicit attachment decoding."""

from __future__ import annotations

import csv
import io
import json
from collections.abc import Iterator, Mapping, Sequence
from importlib import import_module
from typing import TYPE_CHECKING, cast
from urllib.parse import urlsplit

if TYPE_CHECKING:
    import pandas
    import polars
    import pyarrow


def require_library(name: str, *additional: str) -> None:
    for library in (name, *additional):
        try:
            import_module(library)
        except ImportError as cause:
            raise ImportError(f"Install {library} to use this conversion") from cause


def arrow_table(data: bytes) -> pyarrow.Table:
    try:
        import pyarrow as pa
    except ImportError as cause:
        raise ImportError("Install pyarrow to use to_arrow()") from cause
    return pa.ipc.open_stream(data).read_all()


def polars_frame(data: bytes) -> polars.DataFrame:
    try:
        import polars as pl
    except ImportError as cause:
        raise ImportError("Install polars to use to_polars()") from cause
    return pl.read_ipc_stream(io.BytesIO(data))


def pandas_frame(data: bytes) -> pandas.DataFrame:
    return pandas_table(arrow_table(data))


def pandas_table(table: pyarrow.Table) -> pandas.DataFrame:
    try:
        import pandas as pd
    except ImportError as cause:
        raise ImportError("Install pandas to use to_pandas()") from cause
    # Construct directly from columns: Table.to_pandas can corrupt nested list
    # offsets while converting Arrow extension arrays. This also preserves nulls.
    frame = pd.DataFrame(
        {
            index: pd.Series(column, dtype=pd.ArrowDtype(column.type))
            for index, column in enumerate(table.columns)
        },
        index=pd.RangeIndex(table.num_rows),
    )
    frame.columns = table.column_names
    return frame


def file_format(
    name: str, mime_type: str | None, data: bytes, explicit: str | None
) -> str:
    if explicit is not None:
        if explicit not in {"csv", "tsv", "json", "ndjson", "arrow", "parquet", "text"}:
            raise ValueError(
                "format must be csv, tsv, json, ndjson, arrow, parquet, or text"
            )
        return explicit
    if data.startswith(b"PAR1") and data.endswith(b"PAR1"):
        return "parquet"
    if data.startswith((b"ARROW1", b"\xff\xff\xff\xff")):
        return "arrow"
    name = urlsplit(name).path if "://" in name else name
    suffix = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if suffix in {
        "csv",
        "tsv",
        "json",
        "geojson",
        "topojson",
        "ndjson",
        "jsonl",
        "arrow",
        "feather",
        "parquet",
        "txt",
    }:
        return {
            "jsonl": "ndjson",
            "geojson": "json",
            "topojson": "json",
            "feather": "arrow",
            "txt": "text",
        }.get(suffix, suffix)
    mime = (mime_type or "").split(";", 1)[0]
    known = {
        "text/csv": "csv",
        "text/tab-separated-values": "tsv",
        "application/json": "json",
        "application/geo+json": "json",
        "application/x-ndjson": "ndjson",
        "text/plain": "text",
    }
    if mime in known:
        return known[mime]
    if data.lstrip().startswith((b"{", b"[")):
        try:
            json.loads(data)
            return "json"
        except (ValueError, UnicodeError):
            pass
    raise ValueError(f"Cannot infer the format of {name!r}. Pass format= explicitly")


def file_python(data: bytes, format: str) -> object:
    if format == "json":
        return json.loads(data)
    if format == "ndjson":
        return [json.loads(line) for line in data.splitlines() if line.strip()]
    if format in {"csv", "tsv"}:
        with io.StringIO(data.decode("utf-8-sig"), newline="") as source:
            rows = csv.reader(source, delimiter="\t" if format == "tsv" else ",")
            header = csv_header(rows)
            records = []
            for row in rows:
                if not row:
                    continue
                if len(row) != len(header):
                    raise ValueError(
                        "CSV row has a different field count from its header"
                    )
                records.append(dict(zip(header, row, strict=True)))
            return records
    if format == "text":
        return data.decode("utf-8-sig")
    return file_arrow(data, format).to_pylist()


def csv_header(rows: Iterator[list[str]]) -> list[str]:
    header = next((row for row in rows if row), [])
    if len(header) != len(set(header)):
        raise ValueError(
            "CSV contains duplicate column names. Use read_bytes() with explicit column names in your parser"
        )
    return header


def validate_csv_header(data: bytes, format: str) -> list[str]:
    with io.TextIOWrapper(io.BytesIO(data), encoding="utf-8-sig", newline="") as source:
        return csv_header(
            csv.reader(source, delimiter="\t" if format == "tsv" else ",")
        )


def file_arrow(data: bytes, format: str) -> pyarrow.Table:
    try:
        import pyarrow as pa
    except ImportError as cause:
        raise ImportError("Install pyarrow to use to_arrow()") from cause
    if format == "parquet":
        import pyarrow.parquet as pq

        return pq.read_table(io.BytesIO(data))
    if format == "arrow":
        reader = pa.ipc.open_file if data.startswith(b"ARROW1") else pa.ipc.open_stream
        return reader(data).read_all()
    if format in {"csv", "tsv"}:
        import pyarrow.csv as pc

        if not validate_csv_header(data, format):
            return pa.table({})
        return pc.read_csv(
            io.BytesIO(data),
            read_options=pc.ReadOptions(block_size=max(1 << 20, len(data))),
            parse_options=pc.ParseOptions(delimiter="\t" if format == "tsv" else ","),
            convert_options=pc.ConvertOptions(null_values=[""]),
        )
    records = file_records(data, format)
    names = dict.fromkeys(name for record in records for name in record)
    if records and not names:
        batch = pa.RecordBatch.from_struct_array(pa.array(records, type=pa.struct([])))
        return pa.Table.from_batches([batch])
    return pa.table({name: [record.get(name) for record in records] for name in names})


def file_records(data: bytes, format: str) -> list[Mapping[str, object]]:
    value = file_python(data, format)
    records: list[Mapping[str, object]]
    if isinstance(value, Mapping):
        records = [cast(Mapping[str, object], value)]
    elif isinstance(value, list) and all(isinstance(row, Mapping) for row in value):
        records = cast(list[Mapping[str, object]], value)
    elif isinstance(value, list) and all(not isinstance(row, Mapping) for row in value):
        records = [{"value": item} for item in value]
    else:
        raise ValueError("The file does not contain consistently shaped records")
    names = dict.fromkeys(name for record in records for name in record)
    for name in names:
        validate_json_column([record.get(name) for record in records], name)
    return records


def validate_json_column(values: Sequence[object], path: str, depth: int = 0) -> None:
    if depth > 30:
        raise ValueError(
            f"JSON column {path!r} exceeds the dataframe nesting limit. Use to_python()"
        )
    present = [value for value in values if value is not None]
    kinds = {type(value) for value in present}
    if not kinds or kinds <= {str} or kinds <= {bool}:
        return
    if kinds <= {int, float}:
        integers = [value for value in present if type(value) is int]
        if any(value < -(1 << 63) or value >= 1 << 63 for value in integers):
            raise ValueError(
                f"JSON column {path!r} exceeds signed 64-bit integers. Use to_python()"
            )
        if float in kinds and any(int(float(value)) != value for value in integers):
            raise ValueError(
                f"JSON column {path!r} mixes integers and floats that cannot share a lossless type. Use to_python()"
            )
        return
    if kinds == {list}:
        validate_json_column(
            [item for value in present for item in cast(list[object], value)],
            path + "[]",
            depth + 1,
        )
        return
    if kinds == {dict}:
        records = [cast(dict[str, object], value) for value in present]
        for name in dict.fromkeys(name for record in records for name in record):
            validate_json_column(
                [record.get(name) for record in records], path + "." + name, depth + 1
            )
        return
    names = ", ".join(sorted(kind.__name__ for kind in kinds))
    raise ValueError(
        f"JSON column {path!r} mixes incompatible types ({names}). Use to_python()"
    )


def file_polars(data: bytes, format: str) -> polars.DataFrame:
    try:
        import polars as pl
    except ImportError as cause:
        raise ImportError("Install polars to use to_polars()") from cause
    source = io.BytesIO(data)
    if format in {"csv", "tsv"}:
        header = validate_csv_header(data, format)
        if not header:
            return pl.DataFrame()
        # Polars counts a trailing blank CRLF record that the other CSV readers skip.
        return pl.read_csv(
            io.BytesIO(data.rstrip(b"\r\n")),
            separator="\t" if format == "tsv" else ",",
            new_columns=header,
            infer_schema_length=None,
            empty_string_is_null=False,
            eol_char="\r" if b"\r" in data and b"\n" not in data else "\n",
        )
    if format == "parquet":
        return pl.read_parquet(source)
    if format == "arrow":
        return (
            pl.read_ipc(source)
            if data.startswith(b"ARROW1")
            else pl.read_ipc_stream(source)
        )
    if format in {"json", "ndjson"}:
        records = file_records(data, format)
        return (
            pl.from_dicts(records, infer_schema_length=None, strict=False)
            if records
            else pl.DataFrame()
        )
    raise ValueError("The file does not contain tabular data")


def file_pandas(data: bytes, format: str) -> pandas.DataFrame:
    return pandas_table(file_arrow(data, format))
