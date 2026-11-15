"""render_png draws what a reader sees (labels, note text, SQL, saved results, chart descriptions) and its text helpers."""
from io import BytesIO

import pytest
from PIL import Image, ImageChops

from databricks_explore import layout


def window(wid, kind, x=0, y=0, w=500, h=320, **extra):
    n = {"id": wid, "type": kind, "position": {"x": x, "y": y}, "size": {"w": w, "h": h}}
    if kind in ("query", "note", "table"):
        n.update(title=wid + "_title", collapsed=False)
    n.update(extra)
    return n


def canvas(*nodes, edges=()):
    return {"version": 2, "name": "t", "profile": None, "windows": list(nodes), "edges": list(edges)}


def png(c, width=700):
    return Image.open(BytesIO(layout.render_png(c, width))).convert("RGB")


def differs(a, b, width=700):
    return ImageChops.difference(png(a, width), png(b, width)).getbbox() is not None


RESULT = {"columns": [{"name": "category", "type": "STRING"}, {"name": "returned", "type": "BIGINT"}],
          "rows": [["Electronics", "120"], ["Toys", None]], "row_count": 2, "truncated": False, "ran_at": "2026-11-14T10:00:00Z", "sql_hash": "h"}


# ---------------------------------------------------------------- the text helpers

def test_strip_markdown_removes_the_markers_and_keeps_the_words():
    md = "# Finding\n\nReturn rate is **highest** for `Electronics`, *not* _Toys_.\n\n- see [the dashboard](http://x)\n> quoted ~~old~~ new\n1. first"
    assert layout.strip_markdown(md) == "Finding\n\nReturn rate is highest for Electronics, not Toys.\n\n- see the dashboard\nquoted old new\n1. first"


def test_strip_markdown_leaves_snake_case_and_multiplication_alone():
    assert layout.strip_markdown("use return_rate_by_product and 2 * 3 * 4") == "use return_rate_by_product and 2 * 3 * 4"


def test_strip_markdown_drops_fences_rules_and_table_separators_and_joins_table_cells():
    md = "intro\n\n---\n\n```sql\nSELECT 1\n```\n\n| a | b |\n|---|:--:|\n| 1 | 2 |\n\n<b>raw</b> html"
    assert layout.strip_markdown(md) == "intro\n\nSELECT 1\n\na  ·  b\n1  ·  2\n\nraw html"
    assert layout.strip_markdown("") == "" and layout.strip_markdown("\n\n  \n") == ""


def test_sql_excerpt_shows_the_first_lines_and_marks_a_cut():
    sql = "\n\nSELECT a,\n\tb\nFROM t\nWHERE a > 1\nORDER BY a"
    assert layout.sql_excerpt(sql, 10) == ["SELECT a,", "  b", "FROM t", "WHERE a > 1", "ORDER BY a"]
    assert layout.sql_excerpt(sql, 3) == ["SELECT a,", "  b", "FROM t …"]
    assert layout.sql_excerpt("", 3) == [] and layout.sql_excerpt("SELECT 1", 0) == ["SELECT 1"]


def test_result_grid_is_a_header_and_the_first_rows_with_null_and_long_cells_cut():
    res = {"columns": [{"name": "a"}, {"name": "b"}, {"name": "c"}], "rows": [["1", None, "x" * 50], ["2", "y", "z"], ["3", "q", "w"]]}
    grid = layout.result_grid(res, max_cols=3, max_rows=2)
    assert grid == [["a", "b", "c"], ["1", "NULL", "x" * 21 + "…"], ["2", "y", "z"]]
    assert layout.result_grid(res, 2, 1) == [["a", "b", "…"], ["1", "NULL", "…"]]  # a column that does not fit becomes an ellipsis
    assert layout.result_grid({"columns": [], "rows": []}, 3, 3) == [[]]


def test_chart_mark_and_label():
    assert layout.chart_mark({"mark": "bar"}) == "bar" and layout.chart_mark({"mark": {"type": "line"}}) == "line"
    assert layout.chart_mark({"layer": [{"mark": "bar"}, {"mark": "rule"}, {"mark": "bar"}]}) == "bar+rule"
    assert layout.chart_mark({}) == "?" and layout.chart_mark(None) == "?"
    n = window("q", "query", chart={"vega_lite": {"mark": "bar"}}, result=RESULT)
    assert layout.chart_label(n) == "chart: bar, 2 rows"
    assert layout.chart_label(window("q", "query", chart={"vega_lite": {"mark": "bar"}})) == "chart: bar (no saved result)"


# ---------------------------------------------------------------- the picture

def test_a_sticky_label_is_drawn_at_its_font_size():
    base = window("s", "sticky", w=220, h=160, label="")
    labeled = window("s", "sticky", w=220, h=160, label="Check Toys again")
    big = window("s", "sticky", w=220, h=160, label="Check Toys again", font_size=28)
    assert differs(canvas(base), canvas(labeled)) and differs(canvas(labeled), canvas(big))
    ink = lambda c: ImageChops.difference(png(c), png(canvas(base))).getbbox()  # noqa: E731
    assert (ink(canvas(big))[3] - ink(canvas(big))[1]) > (ink(canvas(labeled))[3] - ink(canvas(labeled))[1])  # taller text


def test_text_and_frame_labels_are_drawn():
    for kind in ("text", "frame"):
        assert differs(canvas(window("t", kind, w=300, h=60, label="")), canvas(window("t", kind, w=300, h=60, label="Overall: 7%")))


def test_a_note_shows_its_text_without_the_markdown_markers():
    plain = canvas(window("n", "note", w=360, h=200, text="Return rate is highest for Electronics"))
    marked = canvas(window("n", "note", w=360, h=200, text="Return rate is **highest** for `Electronics`"))
    empty = canvas(window("n", "note", w=360, h=200, text=""))
    assert not differs(plain, marked)  # the markers do not reach the picture
    assert differs(plain, empty)
    other = canvas(window("n", "note", w=360, h=200, text="Return rate is lowest for Toys"))
    assert differs(plain, other)


def test_a_notes_text_stays_inside_the_box_and_ends_with_an_ellipsis_when_it_does_not_fit():
    c = canvas(window("n", "note", w=260, h=110, text="\n".join(f"line {i} of a long note" for i in range(30))))
    empty = canvas(window("n", "note", w=260, h=110, text=""))
    ink = ImageChops.difference(png(c, 400), png(empty, 400)).getbbox()
    assert ink is not None and ink[3] <= png(c, 400).height - 30  # nothing is drawn below the box's bottom edge


def test_a_query_window_shows_its_sql_and_its_saved_result():
    base = window("q", "query", sql="SELECT 1")
    assert differs(canvas(base), canvas(window("q", "query", sql="SELECT category FROM dev.crm.returns")))
    assert differs(canvas(base), canvas(window("q", "query", sql="SELECT 1", result=RESULT)))
    more = {**RESULT, "rows": RESULT["rows"] + [["Home", "55"]]}
    assert differs(canvas(window("q", "query", sql="SELECT 1", result=RESULT)), canvas(window("q", "query", sql="SELECT 1", result=more)))


def test_a_window_on_its_chart_says_chart_and_a_collapsed_one_shows_only_its_title():
    spec = {"vega_lite": {"mark": "bar"}}
    table = canvas(window("q", "query", sql="SELECT 1", result=RESULT, chart=spec))
    chart = canvas(window("q", "query", sql="SELECT 1", result=RESULT, chart=spec, view="chart"))
    assert differs(table, chart)
    assert differs(chart, canvas(window("q", "query", sql="SELECT 1", result=RESULT, chart={"vega_lite": {"mark": "line"}}, view="chart")))
    folded = canvas(window("q", "query", sql="SELECT 1", result=RESULT, collapsed=True))
    assert not differs(folded, canvas(window("q", "query", sql="SELECT something_else", result=RESULT, collapsed=True)))


def test_a_table_card_shows_its_table_name_and_a_placeholder_its_columns():
    a = canvas(window("t", "table", table="dev.crm.orders", h=200))
    assert differs(a, canvas(window("t", "table", table="dev.crm.customers", h=200)))
    ph = lambda cols: canvas(window("p", "placeholder", h=140, placeholder={"id": "x", "name": "dim_customer", "columns": cols}))  # noqa: E731
    assert differs(ph([{"name": "id", "type": "bigint", "key": "pk"}]), ph([{"name": "id", "type": "bigint", "key": "pk"}, {"name": "name", "type": "string"}]))


def test_connector_labels_are_still_drawn():
    nodes = (window("a", "shape", shape="rect", label="A", w=120, h=60), window("b", "shape", x=400, shape="rect", label="B", w=120, h=60))
    edge = {"id": "e", "source": "a", "target": "b", "source_handle": "r", "target_handle": "l", "line": "step"}
    assert differs(canvas(*nodes, edges=[edge]), canvas(*nodes, edges=[{**edge, "label": "joins on order_id"}]))


def test_the_picture_is_deterministic_and_the_content_is_drawn_on_a_large_canvas_too():
    c = canvas(window("q", "query", sql="SELECT 1", result=RESULT), window("n", "note", x=3000, y=2000, text="hello"))
    assert layout.render_png(c, 900) == layout.render_png(c, 900)
    assert png(c, 900).size[0] == 900


def test_a_pillow_without_scalable_fonts_still_renders(monkeypatch):
    from PIL import ImageFont
    real = ImageFont.load_default

    def fixed_only(size=None):
        if size is not None:
            raise TypeError("this Pillow has one size")
        return real()
    monkeypatch.setattr(ImageFont, "load_default", fixed_only)
    c = canvas(window("s", "sticky", w=200, h=120, label="hello"), window("q", "query", x=300, sql="SELECT 1", result=RESULT))
    assert png(c).size[0] == 700


def test_a_result_with_many_columns_and_rows_fits_its_window():
    cols = [{"name": f"column_{i}", "type": "STRING"} for i in range(30)]
    big = {"columns": cols, "rows": [[f"value_{r}_{i}" for i in range(30)] for r in range(100)], "row_count": 1000, "truncated": True,
           "ran_at": "2026-11-14T10:00:00Z", "sql_hash": "h"}
    c = canvas(window("q", "query", w=600, h=300, sql="SELECT *\nFROM wide", result=big))
    empty = canvas(window("q", "query", w=600, h=300, sql="SELECT *\nFROM wide"))
    img = png(c, 500)
    ink = ImageChops.difference(img, png(empty, 500)).getbbox()
    assert ink is not None and ink[2] <= img.width - 30 and ink[3] <= img.height - 30
