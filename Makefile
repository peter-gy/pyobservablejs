.PHONY: check

check: export KONSISTENT_NO_UPDATE_CHECK = 1
check:
	pnpm format:check
	pnpm lint
	pnpm konsistent
	pnpm typecheck
	pnpm test:js
	uv run ruff format --check .
	uv run ruff check
	uv run ty check
	uv run pytest -q
	pnpm build
	uv run python scripts/docs.py build
	git diff --check
