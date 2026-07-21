from __future__ import annotations

import sys
from importlib.metadata import version as distribution_version

import observablejs
from observablejs import (
    NotebookView,
    view_from_code,
    view_from_html,
    view_from_observablehq,
    view_from_observablehq_document,
)


def verify_release(expected_version: str) -> None:
    installed_version = distribution_version("pyobservablejs")
    if installed_version != expected_version:
        raise SystemExit(
            f"Installed pyobservablejs version {installed_version} does not match "
            f"release {expected_version}"
        )

    if observablejs.__version__ != expected_version:
        raise SystemExit(
            f"observablejs.__version__ is {observablejs.__version__}, expected "
            f"{expected_version}"
        )

    factories = {
        "view_from_code": view_from_code,
        "view_from_html": view_from_html,
        "view_from_observablehq": view_from_observablehq,
        "view_from_observablehq_document": view_from_observablehq_document,
    }
    invalid_factories = [
        name for name, factory in factories.items() if not callable(factory)
    ]
    if invalid_factories:
        raise SystemExit(
            f"ObservableJS factories are not callable: {', '.join(invalid_factories)}"
        )

    view = view_from_code("answer = 42")
    try:
        if not isinstance(view, NotebookView):
            raise SystemExit(
                f"view_from_code returned {type(view).__name__}, expected NotebookView"
            )
    finally:
        view.close()


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python scripts/verify_release.py VERSION")

    expected_version = sys.argv[1]
    verify_release(expected_version)
    print(f"Verified pyobservablejs {expected_version}")


if __name__ == "__main__":
    main()
