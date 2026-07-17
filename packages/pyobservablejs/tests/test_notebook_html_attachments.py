from __future__ import annotations

import pathlib

import pytest
from helpers import (
    CommentNodes,
    ScriptTags,
    assert_javascript_import_payloads,
    decode_data_url,
    notebook_from_html_path,
    normalized_source,
    normalized_source_with_embedded_imports,
    script_by_id,
)


def test_from_html_embeds_static_template_and_stdlib_alias_file_attachments(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
) -> None:
    (tmp_path / "templated.csv").write_text("x\n1\n", encoding="utf-8")
    (tmp_path / "aliased.csv").write_text("x\n2\n", encoding="utf-8")
    (tmp_path / "dynamic.csv").write_text("x\n3\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <script id="1" type="module">
    import {FileAttachment as localFile} from "observablehq:stdlib";
    const name = "dynamic";
    const a = FileAttachment(`templated.csv`).csv();
    const b = localFile("aliased.csv").csv();
    const c = FileAttachment(`${name}.csv`).csv();
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = notebook_from_html_path(notebook)
    module_text = script_by_id(script_tags(widget.to_notebook_html()), "1")["text"]

    assert set(widget.attachments) == {"templated.csv", "aliased.csv"}
    assert normalized_source(module_text) == normalized_source(
        """
        import {FileAttachment as localFile} from "observablehq:stdlib";
        const name = "dynamic";
        const a = FileAttachment(`templated.csv`).csv();
        const b = localFile("aliased.csv").csv();
        const c = FileAttachment(`${name}.csv`).csv();
        """
    )
    assert decode_data_url(widget.attachments["templated.csv"]["url"])[1] == b"x\n1\n"
    assert decode_data_url(widget.attachments["aliased.csv"]["url"])[1] == b"x\n2\n"


def test_from_html_embeds_only_bare_file_attachment_calls(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
) -> None:
    (tmp_path / "data.csv").write_text("x,y\n1,2\n", encoding="utf-8")
    (tmp_path / "secret.csv").write_text("x,y\n9,9\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <script id="1" type="module">
    obj.FileAttachment("secret.csv");
    obj?.FileAttachment("secret.csv");
    this.#FileAttachment("secret.csv");
    $FileAttachment("secret.csv");
    FileAttachment("data.csv");
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = notebook_from_html_path(notebook)
    module_text = script_by_id(script_tags(widget.to_notebook_html()), "1")["text"]

    assert set(widget.attachments) == {"data.csv"}
    assert normalized_source(module_text) == normalized_source(
        """
        obj.FileAttachment("secret.csv");
        obj?.FileAttachment("secret.csv");
        this.#FileAttachment("secret.csv");
        $FileAttachment("secret.csv");
        FileAttachment("data.csv");
        """
    )
    assert decode_data_url(widget.attachments["data.csv"]["url"])[1] == b"x,y\n1,2\n"


@pytest.mark.parametrize(
    ("script_type", "body"),
    [
        (
            "text/markdown",
            'Prose mentioning FileAttachment("secret.csv") must not embed it.',
        ),
        ("module", '// FileAttachment("secret.csv")'),
        ("module", "const literal = 'FileAttachment(\"secret.csv\")';"),
        ("module", r'const attachmentPattern = /FileAttachment\("secret.csv"\)/;'),
        ("module", r'function pattern() { return /FileAttachment\("secret.csv"\)/; }'),
        (
            "module",
            r'function sameLine() { const s = "//"; return /FileAttachment\("secret.csv"\)/; }',
        ),
        ("module", r'function fail() { throw /FileAttachment\("secret.csv"\)/; }'),
        (
            "module",
            r'function blockComment() { return /* c */ /FileAttachment\("secret.csv"\)/; }',
        ),
        (
            "module",
            'function lineComment() { throw // c\n  /FileAttachment\\("secret.csv"\\)/; }',
        ),
        ("module", 'if (false) /FileAttachment("secret.csv")/.test("x");'),
        ("module", 'while (false) /FileAttachment("secret.csv")/.test("x");'),
        ("module", 'for (; false;) /FileAttachment("secret.csv")/.test("x");'),
        ("module", 'with ({}) /FileAttachment("secret.csv")/.test("x");'),
        (
            "module",
            'async function f(xs) {\n  for await (const x of xs) /FileAttachment("secret.csv")/.test(x);\n}',
        ),
        (
            "module",
            r'if (false) {} else /FileAttachment\("secret.csv"\)/.test("x");',
        ),
        ("module", r'do /FileAttachment\("secret.csv"\)/.test("x"); while (false);'),
        ("module", r'for (const x of /FileAttachment\("secret.csv"\)/) {}'),
        ("module", r'if ("x" in /FileAttachment\("secret.csv"\)/) {}'),
        ("module", r'if ("x" instanceof /FileAttachment\("secret.csv"\)/) {}'),
    ],
)
def test_from_html_embeds_only_executable_file_attachments(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
    script_type: str,
    body: str,
) -> None:
    (tmp_path / "image.csv").write_text("name\nplot\n", encoding="utf-8")
    (tmp_path / "points.csv").write_text("x,y\n1,2\n", encoding="utf-8")
    (tmp_path / "secret.csv").write_text("x,y\n9,9\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        f"""<!doctype html>
<notebook>
  <script id="1" type="{script_type}">
{body}
  </script>
  <script id="2" type="module">
    const image = html`<img src=${{FileAttachment("image.csv").url()}}>`;
    const points = FileAttachment("points.csv").csv();
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = notebook_from_html_path(notebook)
    ignored_text = script_by_id(script_tags(widget.to_notebook_html()), "1")["text"]
    module_text = script_by_id(script_tags(widget.to_notebook_html()), "2")["text"]

    assert set(widget.attachments) == {"image.csv", "points.csv"}
    assert normalized_source(ignored_text) == normalized_source(body)
    assert normalized_source(module_text) == normalized_source(
        """
        const image = html`<img src=${FileAttachment("image.csv").url()}>`;
        const points = FileAttachment("points.csv").csv();
        """
    )
    assert decode_data_url(widget.attachments["image.csv"]["url"])[1] == b"name\nplot\n"
    mime_type, payload = decode_data_url(widget.attachments["points.csv"]["url"])
    assert mime_type == "text/csv"
    assert payload == b"x,y\n1,2\n"


@pytest.mark.parametrize(
    "body",
    [
        'promise.catch(handler) / FileAttachment("data.csv").size;',
        'obj.return / FileAttachment("data.csv").size;',
        'obj.await / FileAttachment("data.csv").size;',
        'this.#return / FileAttachment("data.csv").size;',
        'this.#catch(handler) / FileAttachment("data.csv").size;',
    ],
)
def test_from_html_discovers_file_attachments_after_member_expression_division(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
    body: str,
) -> None:
    (tmp_path / "data.csv").write_text("x,y\n1,2\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        f"""<!doctype html>
<notebook>
  <script id="1" type="module">
    {body}
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = notebook_from_html_path(notebook)
    module_text = script_by_id(script_tags(widget.to_notebook_html()), "1")["text"]

    assert set(widget.attachments) == {"data.csv"}
    assert module_text.strip() == body
    assert decode_data_url(widget.attachments["data.csv"]["url"])[1] == b"x,y\n1,2\n"


def test_from_html_respects_unquoted_script_types(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
) -> None:
    (tmp_path / "helper.js").write_text("export const value = 1;\n", encoding="utf-8")
    (tmp_path / "points.csv").write_text("x,y\n1,2\n", encoding="utf-8")
    (tmp_path / "secret.csv").write_text("x,y\n9,9\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <script id="1" type=text/markdown>
    import "./helper.js"
    FileAttachment("secret.csv")
  </script>
  <script id="2" type=module>
    import "./helper.js";
    FileAttachment("points.csv");
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = notebook_from_html_path(notebook)

    scripts = script_tags(widget.to_notebook_html())
    markdown_script = script_by_id(scripts, "1")
    module_script = script_by_id(scripts, "2")
    markdown_text = markdown_script["text"]
    module_text = module_script["text"]
    assert markdown_script["attrs"].get("type") == "text/markdown"
    assert module_script["attrs"].get("type") == "module"
    assert normalized_source(markdown_text) == normalized_source(
        """
        import "./helper.js"
        FileAttachment("secret.csv")
        """
    )
    assert_javascript_import_payloads(
        module_text,
        [("import", b"export const value = 1;\n", (), ())],
    )
    assert normalized_source_with_embedded_imports(module_text) == normalized_source(
        """
        import "<embedded>";
        FileAttachment("points.csv");
        """
    )
    assert set(widget.attachments) == {"points.csv"}


def test_from_html_ignores_data_type_when_script_type_is_absent(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
) -> None:
    (tmp_path / "first.js").write_text("export const first = 1;\n", encoding="utf-8")
    (tmp_path / "second.js").write_text("export const second = 2;\n", encoding="utf-8")
    (tmp_path / "points.csv").write_text("x,y\n1,2\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <script id="1" data-type="text/markdown">
    import "./first.js";
    FileAttachment("points.csv");
  </script>
  <script id="2" data-note=" type=text/markdown ">
    import "./second.js";
    FileAttachment("points.csv");
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = notebook_from_html_path(notebook)

    scripts = script_tags(widget.to_notebook_html())
    first_text = script_by_id(scripts, "1")["text"]
    second_text = script_by_id(scripts, "2")["text"]
    assert_javascript_import_payloads(
        first_text,
        [("import", b"export const first = 1;\n", (), ())],
    )
    assert_javascript_import_payloads(
        second_text,
        [("import", b"export const second = 2;\n", (), ())],
    )
    assert normalized_source_with_embedded_imports(first_text) == normalized_source(
        """
        import "<embedded>";
        FileAttachment("points.csv");
        """
    )
    assert normalized_source_with_embedded_imports(second_text) == normalized_source(
        """
        import "<embedded>";
        FileAttachment("points.csv");
        """
    )
    assert set(widget.attachments) == {"points.csv"}


def test_from_html_handles_gt_in_script_attribute_values(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
) -> None:
    (tmp_path / "helper.js").write_text("export const value = 1;\n", encoding="utf-8")
    (tmp_path / "points.csv").write_text("x,y\n1,2\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <script id="1" data-note=">">
    import "./helper.js";
    FileAttachment("points.csv");
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = notebook_from_html_path(notebook)

    script = script_by_id(script_tags(widget.to_notebook_html()), "1")
    module_text = script["text"]
    assert script["attrs"].get("data-note") == ">"
    assert_javascript_import_payloads(
        module_text,
        [("import", b"export const value = 1;\n", (), ())],
    )
    assert normalized_source_with_embedded_imports(module_text) == normalized_source(
        """
        import "<embedded>";
        FileAttachment("points.csv");
        """
    )
    assert set(widget.attachments) == {"points.csv"}


def test_from_html_ignores_scripts_outside_notebook(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
    all_script_tags: ScriptTags,
) -> None:
    (tmp_path / "outside-helper.js").write_text(
        "export const outside = 1;\n", encoding="utf-8"
    )
    (tmp_path / "inside-helper.js").write_text(
        "export const inside = 1;\n", encoding="utf-8"
    )
    (tmp_path / "secret.csv").write_text("x,y\n9,9\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<script type="module">
  import "./outside-helper.js";
  FileAttachment("secret.csv");
</script>
<notebook>
  <script id="1" type="text/markdown">
    import "./inside-helper.js";
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = notebook_from_html_path(notebook)
    rendered = widget.to_notebook_html()
    scripts = script_tags(rendered)
    outside_scripts = [
        script
        for script in all_script_tags(rendered)
        if script["attrs"].get("id") is None
    ]
    notebook_script = script_by_id(scripts, "1")

    assert widget.attachments == {}
    assert len(widget.cells) == 1
    assert len(outside_scripts) == 1
    assert normalized_source(outside_scripts[0]["text"]) == normalized_source(
        """
        import "./outside-helper.js";
        FileAttachment("secret.csv");
        """
    )
    assert [script["attrs"].get("id") for script in scripts] == ["1"]
    assert notebook_script["attrs"].get("type") == "text/markdown"
    assert normalized_source(notebook_script["text"]) == normalized_source(
        """
        import "./inside-helper.js";
        """
    )


def test_from_html_ignores_script_tags_inside_html_comments(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
    comment_nodes: CommentNodes,
) -> None:
    (tmp_path / "helper.js").write_text("export const value = 1;\n", encoding="utf-8")
    (tmp_path / "secret.csv").write_text("x,y\n9,9\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <!--
  <script id="commented" type="module">
    import "./helper.js";
    FileAttachment("secret.csv");
  </script>
  -->
  <script id="real">
    const value = 1;
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = notebook_from_html_path(notebook)
    rendered = widget.to_notebook_html()
    scripts = script_tags(rendered)
    comments = comment_nodes(rendered)
    real_script = script_by_id(scripts, "real")

    assert widget.attachments == {}
    assert len(widget.cells) == 1
    assert [script["attrs"].get("id") for script in scripts] == ["real"]
    assert real_script["text"].strip() == "const value = 1;"
    ignored_comment = next(
        comment for comment in comments if 'id="commented"' in comment
    )
    assert normalized_source(ignored_comment) == normalized_source(
        """
        <script id="commented" type="module">
          import "./helper.js";
          FileAttachment("secret.csv");
        </script>
        """
    )


def test_from_html_ignores_longer_closing_tag_prefixes(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
) -> None:
    (tmp_path / "helper.js").write_text("export const value = 1;\n", encoding="utf-8")
    (tmp_path / "points.csv").write_text("x,y\n1,2\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <script id="1">
    const tag = "</scripture>";
    import "./helper.js";
    FileAttachment("points.csv");
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = notebook_from_html_path(notebook)

    module_text = script_by_id(script_tags(widget.to_notebook_html()), "1")["text"]
    assert_javascript_import_payloads(
        module_text,
        [("import", b"export const value = 1;\n", (), ())],
    )
    assert normalized_source_with_embedded_imports(module_text) == normalized_source(
        """
        const tag = "</scripture>";
        import "<embedded>";
        FileAttachment("points.csv");
        """
    )
    assert set(widget.attachments) == {"points.csv"}


def test_from_html_ignores_notebook_close_text_inside_script(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
) -> None:
    (tmp_path / "helper.js").write_text("export const value = 1;\n", encoding="utf-8")
    (tmp_path / "points.csv").write_text("x,y\n1,2\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <script id="1">
    const tag = "</notebook>";
    import "./helper.js";
    FileAttachment("points.csv");
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = notebook_from_html_path(notebook)

    module_text = script_by_id(script_tags(widget.to_notebook_html()), "1")["text"]
    assert_javascript_import_payloads(
        module_text,
        [("import", b"export const value = 1;\n", (), ())],
    )
    assert normalized_source_with_embedded_imports(module_text) == normalized_source(
        """
        const tag = "</notebook>";
        import "<embedded>";
        FileAttachment("points.csv");
        """
    )
    assert set(widget.attachments) == {"points.csv"}


def test_from_html_treats_unknown_script_type_as_javascript(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
) -> None:
    (tmp_path / "helper.js").write_text("export const value = 1;\n", encoding="utf-8")
    (tmp_path / "points.csv").write_text("x,y\n1,2\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <script id="1" type="text/custom">
    import "./helper.js";
    FileAttachment("points.csv");
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = notebook_from_html_path(notebook)

    assert len(widget.cells) == 1
    module_text = script_by_id(script_tags(widget.to_notebook_html()), "1")["text"]
    assert_javascript_import_payloads(
        module_text,
        [("import", b"export const value = 1;\n", (), ())],
    )
    assert normalized_source_with_embedded_imports(module_text) == normalized_source(
        """
        import "<embedded>";
        FileAttachment("points.csv");
        """
    )
    assert set(widget.attachments) == {"points.csv"}


def test_from_html_rewrites_minified_static_imports(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
) -> None:
    (tmp_path / "import-helper.js").write_text(
        "export const value = 1;\n", encoding="utf-8"
    )
    (tmp_path / "export-helper.js").write_text(
        "export const value = 2;\n", encoding="utf-8"
    )
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <script id="1" type="module">
    import{value}from"./import-helper.js";
    export{value}from"./export-helper.js";
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = notebook_from_html_path(notebook)

    module_text = script_by_id(script_tags(widget.to_notebook_html()), "1")["text"]
    assert_javascript_import_payloads(
        module_text,
        [
            ("import", b"export const value = 1;\n", ("value",), ()),
            ("export", b"export const value = 2;\n", (), ("value",)),
        ],
    )
