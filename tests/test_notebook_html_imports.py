from __future__ import annotations

import pathlib
from typing import Any

import pyobservablejs as obs
import pytest
from helpers import (
    ScriptTags,
    assert_javascript_import_payloads,
    assert_no_relative_javascript_import_specifiers,
    decode_data_url,
    decoded_data_imports,
    javascript_imports,
    notebook_from_html_file,
    normalized_source,
    normalized_source_with_embedded_imports,
    script_by_id,
)


def test_from_html_embeds_file_attachments_and_local_imports(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
) -> None:
    data = tmp_path / "data"
    data.mkdir()
    (data / "points.csv").write_text("x,y\n1,2\n", encoding="utf-8")
    (tmp_path / "helper.js").write_text("export const value = 1;\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <title>Example</title>
  <script id="1" type="module">
    import {value} from "./helper.js";
    const points = FileAttachment("data/points.csv").csv();
    display(value);
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = notebook_from_html_file(notebook)

    assert set(widget.attachments) == {"data/points.csv"}
    mime_type, payload = decode_data_url(widget.attachments["data/points.csv"]["url"])
    assert mime_type == "text/csv"
    assert payload == b"x,y\n1,2\n"
    module_text = script_by_id(script_tags(widget.to_notebook_html()), "1")["text"]
    assert_javascript_import_payloads(
        module_text,
        [("import", b"export const value = 1;\n", ("value",), ())],
    )
    assert normalized_source_with_embedded_imports(module_text) == normalized_source(
        """
        import {value} from "<embedded>";
        const points = FileAttachment("data/points.csv").csv();
        display(value);
        """
    )
    assert len(widget.cells) == 1


def test_from_html_recursively_embeds_local_imports(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
) -> None:
    (tmp_path / "nested.js").write_text("export const nested = 41;\n", encoding="utf-8")
    (tmp_path / "helper.js").write_text(
        'import {nested} from "./nested.js";\nexport const value = nested + 1;\n',
        encoding="utf-8",
    )
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <script id="1" type="module">
    import {value} from "./helper.js";
    display(value);
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = notebook_from_html_file(notebook)

    module_text = script_by_id(script_tags(widget.to_notebook_html()), "1")["text"]
    [(kind, mime_type, payload, imported, exported)] = decoded_data_imports(
        javascript_imports(module_text)
    )
    helper_text = payload.decode("utf-8")
    assert_no_relative_javascript_import_specifiers(module_text)
    assert (kind, mime_type, imported, exported) == (
        "import",
        "text/javascript",
        ("value",),
        (),
    )
    assert normalized_source_with_embedded_imports(helper_text) == normalized_source(
        """
        import {nested} from "<embedded>";
        export const value = nested + 1;
        """
    )
    assert_javascript_import_payloads(
        helper_text,
        [("import", b"export const nested = 41;\n", ("nested",), ())],
    )


def test_from_html_requires_html_string(tmp_path: pathlib.Path) -> None:
    path = tmp_path / "chart.html"
    path.write_text("<notebook></notebook>", encoding="utf-8")
    bad_source: Any = path

    with pytest.raises(TypeError, match="HTML string"):
        obs.Notebook.from_html(bad_source)


SOURCE_BACKED_NAMED_CELLS = """<!doctype html>
<notebook>
  <script id="10" type="text/markdown" name="title"># Title</script>
  <script id="11" type="module" name="svg">const svg = ({node: () => "live"});</script>
  <script id="12" type="module" name="display">svg.node()</script>
</notebook>
"""


def test_source_backed_notebook_exposes_one_cell_per_script() -> None:
    widget = obs.Notebook.from_html(SOURCE_BACKED_NAMED_CELLS)

    assert len(widget.cells) == 3
    assert [widget.cell(index).name for index in range(3)] == [
        "title",
        "svg",
        "display",
    ]
    display_cell = widget.cell("display")
    svg_cell = widget.cell("svg")
    assert display_cell.name == "display"
    assert svg_cell.name == "svg"


def test_source_backed_notebook_preserves_input_html() -> None:
    widget = obs.Notebook.from_html(SOURCE_BACKED_NAMED_CELLS)

    assert widget.to_notebook_html() == SOURCE_BACKED_NAMED_CELLS


def test_from_html_does_not_rewrite_markdown_import_text(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
) -> None:
    (tmp_path / "helper.js").write_text("export const value = 1;\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
	<notebook>
	  <script id="1" type="text/markdown">
	    Prose mentioning from "./helper.js" must remain text.
	  </script>
	</notebook>
	""",
        encoding="utf-8",
    )

    widget = notebook_from_html_file(notebook)

    markdown_text = script_by_id(script_tags(widget.to_notebook_html()), "1")["text"]
    assert (
        markdown_text.strip() == 'Prose mentioning from "./helper.js" must remain text.'
    )
    assert widget.attachments == {}


def test_from_html_rewrites_static_and_dynamic_javascript_imports(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
) -> None:
    (tmp_path / "side-effect.js").write_text(
        "export const side = 1;\n", encoding="utf-8"
    )
    (tmp_path / "comment-side-effect.js").write_text(
        "export const commentedSide = 2;\n", encoding="utf-8"
    )
    (tmp_path / "named.js").write_text("export const value = 3;\n", encoding="utf-8")
    (tmp_path / "dynamic.js").write_text(
        "export const dynamic = 4;\n", encoding="utf-8"
    )
    (tmp_path / "dynamic-comment.js").write_text(
        "export const dynamicComment = 5;\n", encoding="utf-8"
    )
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
	  <script id="2" type="module">
	    import "./side-effect.js";
	    import /* side effect */ "./comment-side-effect.js";
	    import {value} from /* from */ "./named.js";
	    const dynamic = html`${import("./dynamic.js")}`;
	    const dynamicWithComment = html`${import /* dynamic */ ("./dynamic-comment.js")}`;
	  </script>
	</notebook>
		""",
        encoding="utf-8",
    )

    widget = notebook_from_html_file(notebook)

    module_text = script_by_id(script_tags(widget.to_notebook_html()), "2")["text"]
    assert_javascript_import_payloads(
        module_text,
        [
            ("import", b"export const side = 1;\n", (), ()),
            ("import", b"export const commentedSide = 2;\n", (), ()),
            ("import", b"export const value = 3;\n", ("value",), ()),
            ("dynamic-import", b"export const dynamic = 4;\n", (), ()),
            (
                "dynamic-import",
                b"export const dynamicComment = 5;\n",
                (),
                (),
            ),
        ],
    )
    assert normalized_source_with_embedded_imports(module_text) == normalized_source(
        """
        import "<embedded>";
        import /* side effect */ "<embedded>";
        import {value} from /* from */ "<embedded>";
        const dynamic = html`${import("<embedded>")}`;
        const dynamicWithComment = html`${import /* dynamic */ ("<embedded>")}`;
        """
    )
    assert len(widget.cells) == 1


def test_from_html_preserves_non_executable_import_text(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
) -> None:
    (tmp_path / "helper.js").write_text("export const value = 1;\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
	  <script id="1" type="module">
	    import "./helper.js";
	    // import "./helper.js";
	    const literal = 'import "./helper.js"';
	    const importPattern = /import\\("\\.\\/helper\\.js"\\)/;
	  </script>
	</notebook>
""",
        encoding="utf-8",
    )

    widget = notebook_from_html_file(notebook)

    module_text = script_by_id(script_tags(widget.to_notebook_html()), "1")["text"]
    assert_javascript_import_payloads(
        module_text,
        [("import", b"export const value = 1;\n", (), ())],
    )
    assert normalized_source_with_embedded_imports(module_text) == normalized_source(
        r"""
        import "<embedded>";
        // import "./helper.js";
        const literal = 'import "./helper.js"';
        const importPattern = /import\("\.\/helper\.js"\)/;
        """
    )


def test_from_html_does_not_rewrite_import_named_methods(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
) -> None:
    (tmp_path / "helper.js").write_text("export const value = 1;\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <script id="1" type="module">
    const method = obj.import("./helper.js");
    const optional = obj?.import("./helper.js");
    const privateMethod = this.#import("./helper.js");
    const real = import("./helper.js");
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = notebook_from_html_file(notebook)

    module_text = script_by_id(script_tags(widget.to_notebook_html()), "1")["text"]
    assert_javascript_import_payloads(
        module_text,
        [("dynamic-import", b"export const value = 1;\n", (), ())],
    )
    assert normalized_source_with_embedded_imports(module_text) == normalized_source(
        """
        const method = obj.import("./helper.js");
        const optional = obj?.import("./helper.js");
        const privateMethod = this.#import("./helper.js");
        const real = import("<embedded>");
        """
    )


def test_from_html_allows_comments_between_file_attachment_tokens(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
) -> None:
    (tmp_path / "block.csv").write_text("x,y\n1,2\n", encoding="utf-8")
    (tmp_path / "line.csv").write_text("x,y\n3,4\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <script id="1" type="module">
    const a = FileAttachment /* block */ ("block.csv").csv();
    const b = FileAttachment // line
      ("line.csv").csv();
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = notebook_from_html_file(notebook)
    module_text = script_by_id(script_tags(widget.to_notebook_html()), "1")["text"]

    assert set(widget.attachments) == {"block.csv", "line.csv"}
    assert normalized_source(module_text) == normalized_source(
        """
        const a = FileAttachment /* block */ ("block.csv").csv();
        const b = FileAttachment // line
          ("line.csv").csv();
        """
    )
    assert decode_data_url(widget.attachments["block.csv"]["url"])[1] == b"x,y\n1,2\n"
    assert decode_data_url(widget.attachments["line.csv"]["url"])[1] == b"x,y\n3,4\n"
