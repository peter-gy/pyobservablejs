from __future__ import annotations

import asyncio
import dataclasses
from collections.abc import Iterator
from typing import Any

import observablejs as obs
import pytest
import traitlets
from helpers import Browser


@pytest.fixture
def browser(monkeypatch: pytest.MonkeyPatch) -> Iterator[Browser]:
    notebook = obs.Notebook(obs.ojs("answer = 42", key="answer"))
    view = notebook.view()
    yield Browser(view, monkeypatch)
    notebook.close()


def diagnostic(**updates: Any) -> dict[str, Any]:
    return {
        "name": "TypeError",
        "message": "source failed",
        "origin": "notebook",
        "phase": "evaluation",
        "component": "packages/runtime/src/cell-state.ts",
        "operation": "evaluate cell",
        "stack": "TypeError: source failed\n at authored (notebook.js:2:1)",
        "cell": {
            "index": 0,
            "id": 1,
            "key": "answer",
            "mode": "ojs",
            "source": "answer = broken()",
        },
        **updates,
    }


def publish(
    browser: Browser,
    errors: list[dict[str, Any]],
    *,
    revision: int = 1,
    sequence: int = 0,
) -> None:
    browser.view.set_state(
        {"_diagnostics": {"revision": revision, "sequence": sequence, "errors": errors}}
    )


def snapshot(
    revision: int,
    *,
    errors: list[dict[str, Any]] | None = None,
    pending: bool = False,
) -> dict[str, Any]:
    cell_errors = errors or []
    return {
        "revision": revision,
        "input_revision": revision,
        "settled_revision": None if pending else revision,
        "pending": pending,
        "graph": {},
        "errors": [],
        "results": {
            "0": {
                "revision": revision,
                "status": "pending"
                if pending
                else "error"
                if cell_errors
                else "success",
                "values": {} if pending or cell_errors else {"answer": 42},
                "errors": cell_errors,
            }
        },
    }


def readback(
    browser: Browser,
    revision: int,
    *,
    errors: list[dict[str, Any]] | None = None,
    pending: bool = False,
) -> None:
    browser.view.set_state(
        {"_readback": snapshot(revision, errors=errors, pending=pending)}
    )


def test_diagnostics_are_monotonic_detached_and_available_without_capture(
    browser: Browser,
) -> None:
    browser.view.set_trait("_capture_state", False)
    changes = []
    browser.view.observe(changes.append, names="diagnostics")
    raw = diagnostic(
        cause={"name": "RangeError", "message": "bad input", "stack": "inner stack"}
    )
    publish(browser, [raw], revision=2)
    saved = browser.view.diagnostics
    raw["cell"]["source"] = "changed"
    raw["cause"]["message"] = "changed"
    assert saved[0].cell is not None and saved[0].cell.source == "answer = broken()"
    assert saved[0].cause is not None and saved[0].cause.message == "bad input"
    with pytest.raises(dataclasses.FrozenInstanceError):
        saved[0].__setattr__("message", "changed")
    with pytest.raises(traitlets.TraitError):
        browser.view.__setattr__("diagnostics", ())
    publish(browser, [], revision=1)
    assert browser.view.diagnostics == saved
    publish(browser, [], revision=3)
    assert browser.view.diagnostics == ()
    assert len(changes) == 2
    assert browser.view.state.input_revision is None


def test_checkpoint_trace_contains_components_cell_source_stack_and_causes(
    browser: Browser,
) -> None:
    publish(
        browser,
        [
            diagnostic(
                cause={
                    "name": "Error",
                    "message": "inner failure",
                    "stack": "inner stack",
                    "cause": {"name": "Error", "message": "root failure"},
                }
            )
        ],
    )
    with pytest.raises(obs.errors.NotebookError) as caught:
        browser.view.raise_for_errors()
    message = str(caught.value)
    assert "packages/runtime/src/cell-state.ts" in message
    assert "Origin: notebook, phase: evaluation" in message
    assert "index=0, id=1, mode=ojs" in message
    assert "1 | answer = broken()" in message
    assert "at authored (notebook.js:2:1)" in message
    assert "Caused by Error: inner failure\ninner stack" in message
    assert "Caused by Error: root failure" in message
    assert caught.value.diagnostics == browser.view.diagnostics


def test_authored_error_names_preserve_notebook_origin(browser: Browser) -> None:
    publish(browser, [diagnostic(name="ProtocolError")])
    with pytest.raises(obs.errors.NotebookError):
        browser.view.raise_for_errors()


@pytest.mark.parametrize(
    ("record", "exception"),
    [
        (
            diagnostic(origin="runtime", component="packages/runtime/src/mount.ts"),
            obs.errors.WidgetError,
        ),
        (
            diagnostic(
                origin="widget",
                phase="transport",
                name="NetworkError",
                component="packages/widget/src/view.ts",
            ),
            obs.errors.WidgetError,
        ),
        (
            diagnostic(
                origin="widget",
                phase="transport",
                name="ProtocolError",
                component="packages/widget/src/requests.ts",
            ),
            obs.errors.ProtocolError,
        ),
        (
            diagnostic(
                origin="widget",
                phase="serialization",
                component="packages/widget/src/values.ts",
            ),
            obs.errors.SerializationError,
        ),
    ],
)
def test_checkpoint_classifies_infrastructure_failures(
    browser: Browser, record: dict[str, Any], exception: type[Exception]
) -> None:
    publish(browser, [record])
    with pytest.raises(exception):
        browser.view.raise_for_errors()


def test_authoritative_clear_overrides_older_readback_errors(browser: Browser) -> None:
    readback(
        browser,
        1,
        errors=[{"name": "Error", "message": "old failure", "phase": "evaluation"}],
    )
    with pytest.raises(obs.errors.NotebookError):
        browser.view.raise_for_errors()
    publish(browser, [])
    browser.view.raise_for_errors()


def test_fatal_diagnostics_fail_bootstrap_reads_before_runtime_ready(
    browser: Browser,
) -> None:
    async def run() -> None:
        pending = asyncio.create_task(browser.view.read("answer", format="json"))
        asyncio.get_running_loop().call_soon(
            publish,
            browser,
            [
                diagnostic(
                    origin="widget",
                    phase="rendering",
                    component="packages/widget/src/view.ts",
                )
            ],
        )
        with pytest.raises(obs.errors.WidgetError):
            await pending
        with pytest.raises(obs.errors.WidgetError):
            await browser.view.read("answer", format="json")

    asyncio.run(run())


def test_authored_diagnostics_do_not_fail_unrelated_reads(browser: Browser) -> None:
    async def run() -> None:
        browser.ready()
        pending = asyncio.create_task(browser.view.read("answer", format="json"))
        request = await browser.message()
        publish(browser, [diagnostic()])
        browser.reply(
            request,
            {"cell": 0, "name": "answer", "revision": 1, "format": "json", "data": 42},
        )
        assert (await pending).data == 42

    asyncio.run(run())


def test_bootstrap_failure_rejects_ready_after_existing_notebook_updates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    notebook = obs.Notebook(obs.ojs("answer = 42", key="answer"))
    notebook.update_variables({"answer": 43})
    browser = Browser(notebook.view(), monkeypatch)
    record = diagnostic(
        origin="widget",
        phase="transport",
        component="packages/widget/src/view.ts",
        operation="resolve session",
    )
    del record["cell"]

    async def run() -> None:
        pending = asyncio.create_task(browser.view.ready())
        asyncio.get_running_loop().call_soon(publish, browser, [record])
        with pytest.raises(obs.errors.WidgetError, match="resolve session"):
            await asyncio.wait_for(pending, 1)

    try:
        asyncio.run(run())
    finally:
        notebook.close()


@pytest.mark.parametrize(
    ("record", "exception"),
    [
        (diagnostic(name="TimeoutError"), obs.errors.NotebookError),
        (
            diagnostic(
                origin="runtime",
                name="ProtocolError",
                component="packages/runtime/src/read.ts",
            ),
            obs.errors.WidgetError,
        ),
        (
            diagnostic(
                origin="widget",
                phase="transport",
                component="packages/widget/src/requests.ts",
            ),
            obs.errors.ReadError,
        ),
        (
            diagnostic(
                origin="widget",
                phase="serialization",
                component="packages/widget/src/requests.ts",
            ),
            obs.errors.SerializationError,
        ),
        (
            diagnostic(
                origin="widget",
                phase="transport",
                name="StaleViewError",
                component="packages/widget/src/requests.ts",
            ),
            obs.errors.StaleViewError,
        ),
    ],
)
def test_read_error_taxonomy_preserves_remote_ownership(
    browser: Browser,
    record: dict[str, Any],
    exception: type[obs.errors.ObservableError],
) -> None:
    async def run() -> None:
        browser.ready()
        pending = asyncio.create_task(browser.view.read("answer", format="json"))
        request = await browser.message()
        browser.deliver(
            type="response", id=request["id"], generation="first", error=record
        )
        with pytest.raises(exception) as caught:
            await pending
        assert type(caught.value) is exception
        assert caught.value.diagnostics[0].origin == record["origin"]

    asyncio.run(run())


def test_renewed_fatal_report_fails_waiting_work_at_the_new_sequence(
    browser: Browser,
) -> None:
    async def run() -> None:
        record = diagnostic(
            origin="widget", phase="rendering", component="packages/widget/src/view.ts"
        )
        publish(browser, [record])
        browser.view.notebook.update_variables({"fix": True})
        pending = asyncio.create_task(browser.view.read("answer", format="json"))
        asyncio.get_running_loop().call_soon(
            lambda: publish(browser, [record], revision=2, sequence=1)
        )
        with pytest.raises(obs.errors.WidgetError):
            await pending

    asyncio.run(run())


@pytest.mark.parametrize("origin", ["notebook", "runtime"])
def test_ready_acknowledges_current_updates_and_recovers_from_prior_errors(
    browser: Browser,
    origin: str,
) -> None:
    async def run() -> None:
        browser.ready()
        readback(
            browser,
            1,
            errors=[{"name": "Error", "message": "old failure", "phase": "evaluation"}],
        )
        publish(browser, [diagnostic(origin=origin)])
        browser.view.notebook.update_variables({"fix": True})
        pending = asyncio.create_task(browser.view.ready())
        request = await browser.message()
        assert request["params"] == {"operation": "ready", "sequence": 1}
        browser.reply(
            request,
            {
                "ready": True,
                "readback": snapshot(2),
                "diagnostics": {
                    "revision": 2,
                    "sequence": request["params"]["sequence"],
                    "errors": [],
                },
            },
        )
        state = await pending
        assert state is browser.view.state and state.input_revision == 2
        assert state.result("answer").values["answer"] == 42
        assert browser.view.diagnostics == ()

    asyncio.run(run())


def test_ready_aggregates_current_diagnostics_from_a_remote_rejection(
    browser: Browser,
) -> None:
    async def run() -> None:
        browser.ready()
        pending = asyncio.create_task(browser.view.ready())
        request = await browser.message()
        first, second = (
            diagnostic(),
            diagnostic(name="SyntaxError", message="another failure"),
        )
        browser.deliver(
            type="response",
            id=request["id"],
            generation="first",
            error=first,
            diagnostics={"revision": 1, "sequence": 0, "errors": [first, second]},
        )
        with pytest.raises(obs.errors.NotebookError) as caught:
            await pending
        assert len(caught.value.diagnostics) == 2

    asyncio.run(run())


def test_ready_response_clears_prior_diagnostics_at_the_same_sequence(
    browser: Browser,
) -> None:
    async def run() -> None:
        browser.ready()
        publish(browser, [diagnostic()])
        pending = asyncio.create_task(browser.view.ready())
        request = await browser.message()
        browser.reply(
            request,
            {
                "ready": True,
                "readback": snapshot(2),
                "diagnostics": {"revision": 2, "sequence": 0, "errors": []},
            },
        )
        assert (await pending).result("answer").values["answer"] == 42
        assert browser.view.diagnostics == ()

    asyncio.run(run())


def test_ready_rejects_a_checkpoint_superseded_by_new_python_updates(
    browser: Browser,
) -> None:
    async def run() -> None:
        browser.ready()
        readback(browser, 1)
        publish(browser, [])
        pending = asyncio.create_task(browser.view.ready())
        request = await browser.message()
        browser.view.notebook.update_variables({"later": True})
        browser.reply(
            request,
            {
                "ready": True,
                "readback": snapshot(1),
                "diagnostics": {
                    "revision": 2,
                    "sequence": request["params"]["sequence"],
                    "errors": [],
                },
            },
        )
        with pytest.raises(obs.errors.StaleViewError):
            await pending

    asyncio.run(run())


def test_ready_requires_capture_and_rejects_an_ack_without_state(
    browser: Browser,
) -> None:
    async def run() -> None:
        browser.view.set_trait("_capture_state", False)
        with pytest.raises(ValueError, match="capture_state=True"):
            await browser.view.ready()
        browser.view.set_trait("_capture_state", True)
        browser.ready()
        pending = asyncio.create_task(browser.view.ready())
        request = await browser.message()
        browser.reply(
            request,
            {
                "ready": True,
                "readback": {},
                "diagnostics": {"revision": 2, "sequence": 0, "errors": []},
            },
        )
        with pytest.raises(
            obs.errors.ProtocolError, match="readiness response|readback"
        ):
            await pending

    asyncio.run(run())


@pytest.mark.parametrize("pending", [False, True])
def test_ready_response_preserves_newer_browser_state(
    browser: Browser, pending: bool
) -> None:
    async def run() -> None:
        browser.ready()
        waiting = asyncio.create_task(browser.view.ready())
        request = await browser.message()
        readback(browser, 3, pending=pending)
        state = browser.view.state
        browser.reply(
            request,
            {
                "ready": True,
                "readback": snapshot(2),
                "diagnostics": {
                    "revision": 2,
                    "sequence": request["params"]["sequence"],
                    "errors": [],
                },
            },
        )
        if pending:
            with pytest.raises(obs.errors.StaleViewError):
                await waiting
        else:
            assert await waiting == state
        assert browser.view.state == state

    asyncio.run(run())


@pytest.mark.parametrize(
    "wire",
    [
        [],
        {"_readback": []},
        {"_diagnostics": []},
        {"_inspection": []},
        {"_datasets": []},
        {"_session": "IPY_MODEL_missing"},
        {
            "_diagnostics": {
                "revision": 1,
                "sequence": 0,
                "errors": [{"message": "invalid"}],
            }
        },
    ],
)
def test_invalid_browser_traits_fail_pending_work_with_protocol_errors(
    browser: Browser, wire: Any
) -> None:
    async def run() -> None:
        browser.ready()
        pending = asyncio.create_task(browser.view.ready())
        await browser.message()
        with pytest.raises(obs.errors.ProtocolError):
            browser.view.set_state(wire)
        with pytest.raises(obs.errors.ProtocolError) as caught:
            await pending
        assert "packages/pyobservablejs/src/observablejs/_notebook.py" in str(
            caught.value
        )
        assert browser.view.diagnostics == ()

    asyncio.run(run())


def test_readback_preserves_optional_rich_error_context(browser: Browser) -> None:
    record = diagnostic(cause={"name": "Error", "message": "inner"}, variable="answer")
    readback(browser, 1, errors=[record])
    error = browser.view.state.result("answer").errors[0]
    assert (
        error.origin == "notebook"
        and error.component == "packages/runtime/src/cell-state.ts"
    )
    assert error.stack == record["stack"]
    assert error.cause is not None and error.cause.message == "inner"
    with pytest.raises(obs.errors.NotebookError, match="answer = broken"):
        browser.view.raise_for_errors()
