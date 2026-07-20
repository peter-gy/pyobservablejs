"""JavaScript-safe notebook cell ID allocation."""

from __future__ import annotations

import dataclasses

_MAX_SAFE_CELL_ID = (1 << 53) - 1


def _is_safe_cell_id(value: object) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and 1 <= value <= _MAX_SAFE_CELL_ID
    )


@dataclasses.dataclass
class _CellIdAllocator:
    reserved: set[int]
    next_id: int = 1

    def advance_past(self, cell_id: int) -> None:
        if cell_id >= self.next_id:
            self.next_id = cell_id + 1

    def allocate(self) -> int:
        cell_id = self._find(self.next_id, _MAX_SAFE_CELL_ID)
        if cell_id is None:
            cell_id = self._find(1, min(self.next_id - 1, _MAX_SAFE_CELL_ID))
        if cell_id is None:
            raise ValueError("Notebook has no available JavaScript-safe cell id")
        self.reserved.add(cell_id)
        self.next_id = cell_id + 1
        return cell_id

    def _find(self, start: int, stop: int) -> int | None:
        candidate = max(start, 1)
        while candidate <= stop and candidate in self.reserved:
            candidate += 1
        return candidate if candidate <= stop else None
