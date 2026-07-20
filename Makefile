.PHONY: build check check-release clean docs docs-serve

VP := node_modules/.bin/vp

build:
	$(VP) run -F './packages/*' build
	uv build --package pyobservablejs

docs:
	UV_NO_DEFAULT_GROUPS=1 $(VP) run -F @pyobservablejs/docs build

docs-serve: docs
	$(VP) run -F @pyobservablejs/docs serve

check:
	$(VP) run check
	$(VP) run -r test
	uv run --package pyobservablejs ruff format --check .
	uv run --package pyobservablejs ruff check
	uv run --package pyobservablejs ty check packages/pyobservablejs scripts
	uv run --package pyobservablejs pyrefly check --min-severity warn
	$(MAKE) build
	uv run --package pyobservablejs pytest -q packages/pyobservablejs/tests
	$(MAKE) docs
	git diff --check

check-release:
	uv lock --check
	$(VP) run -r test
	$(VP) run -F @pyobservablejs/python build
	uv run --package pyobservablejs pytest -q packages/pyobservablejs/tests
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
		node_modules/.cache \
		node_modules/.vite \
		node_modules/.vite-temp \
		packages/*/dist \
		packages/*/node_modules/.cache \
		packages/*/node_modules/.vite \
		packages/*/node_modules/.vite-temp \
		packages/pyobservablejs/src/observablejs/static \
		apps/docs/.docusaurus \
		apps/docs/build
	find .github apps packages/pyobservablejs scripts development_docs \
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
	find .github apps packages/pyobservablejs scripts development_docs \
		-type d -name node_modules -prune -o \
		-type f \( -name '*.pyc' -o -name '*.pyo' -o -name .DS_Store \) -delete
