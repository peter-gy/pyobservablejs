.PHONY: build check clean docs docs-serve

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
	$(MAKE) build
	uv run --package pyobservablejs pytest -q packages/pyobservablejs/tests
	$(MAKE) docs
	git diff --check

clean:
	rm -rf \
		.DS_Store \
		.mypy_cache \
		.pyrefly_cache \
		.pytest_cache \
		.ruff_cache \
		.ty_cache \
		dist \
		docs/.jupyter-book-marimo \
		docs/_build \
		node_modules/.cache \
		node_modules/.vite \
		node_modules/.vite-temp \
		packages/*/dist \
		packages/*/node_modules/.cache \
		packages/*/node_modules/.vite \
		packages/*/node_modules/.vite-temp \
		packages/pyobservablejs/src/observablejs/static
	find .github packages/pyobservablejs scripts docs development_docs \
		-type d -name node_modules -prune -o \
		-type d \( \
			-name __pycache__ -o \
			-name .ipynb_checkpoints -o \
			-name .mypy_cache -o \
			-name .pyrefly_cache -o \
			-name .pytest_cache -o \
			-name .ruff_cache -o \
			-name .ty_cache \
		\) -prune -exec rm -rf {} +
	find .github packages/pyobservablejs scripts docs development_docs \
		-type d -name node_modules -prune -o \
		-type f \( -name '*.pyc' -o -name '*.pyo' -o -name .DS_Store \) -delete
