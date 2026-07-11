.PHONY: check

check:
	pnpm check
	pnpm test
	uv run --package pyobservablejs ruff format --check .
	uv run --package pyobservablejs ruff check
	uv run --package pyobservablejs ty check packages/pyobservablejs scripts
	uv run --package pyobservablejs pyrefly check --min-severity warn
	uv run --package pyobservablejs pytest -q packages/pyobservablejs/tests
	pnpm build
	uv run --package pyobservablejs python scripts/docs.py build
	git diff --check
