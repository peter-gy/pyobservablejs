.PHONY: build check docs docs-serve

build:
	pnpm build
	uv build --package pyobservablejs

docs:
	cd docs && uv run --package pyobservablejs jupyter book build --html --strict

docs-serve: docs
	uv run --package pyobservablejs python -m http.server --bind 127.0.0.1 --directory docs/_build/html 27331

check:
	pnpm check
	pnpm test
	uv run --package pyobservablejs ruff format --check .
	uv run --package pyobservablejs ruff check
	uv run --package pyobservablejs ty check packages/pyobservablejs scripts
	uv run --package pyobservablejs pyrefly check --min-severity warn
	uv run --package pyobservablejs pytest -q packages/pyobservablejs/tests
	$(MAKE) build
	$(MAKE) docs
	git diff --check
