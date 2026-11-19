"""Export a Graph as Mermaid text or a PNG with a title, a legend of what is drawn and the date its facts were read.

Two lenses: flow (a flowchart of data movement) and model (an erDiagram of key references). Reads only what the
caller hands over (the edges as saved, the cached table metadata); never queries."""
import math
import re
from datetime import datetime, timezone
from io import BytesIO
from typing import Callable, Iterable, Optional

from . import cardinality
from .edge_families import family_of

LENSES = ("flow", "model")
GLYPHS = {"aggregate": "Σ", "join": "⋈", "union": "∪", "dedupe": "1", "filter": "▽"}  # the marks of a flow edge's transform
_LEFT = {"one": "||", "zero_one": "|o", "one_many": "}|", "zero_many": "}o"}  # the end at the entity written first
_RIGHT = {"one": "||", "zero_one": "o|", "one_many": "|{", "zero_many": "o{"}  # the end at the entity written second
_UNKNOWN = "zero_many"  # Mermaid has no unknown end; zero or more claims nothing
_END_TEXT = "ends: || exactly one, o| zero or one, o< zero or more"  # the same words as the page's legend


def shown(e: dict) -> bool:
    """Whether the Graph draws the edge by default: not a meaning link, not rejected, not superseded."""
    return family_of(e.get("kind")) != "meaning" and e.get("status") not in ("rejected", "superseded") and e.get("source") != e.get("target")


def is_inferred(e: dict) -> bool:
    """Dashed on the Graph: proposed, not declared or measured."""
    return e.get("status") == "proposed"


def _drawn(lens: str, edges: list[dict]) -> list[dict]:
    """The edges a lens draws: flow and reference edges for flow, reference edges for model."""
    return [e for e in edges if shown(e) and (lens == "flow" or family_of(e.get("kind")) == "reference")]


def short_names(ids: Iterable[str]) -> dict[str, str]:
    """{table: name}: the table's own name, or schema.name, or the full name when two tables share the shorter one."""
    ids = sorted(set(ids))
    for depth in (1, 2, 3):
        names = {t: ".".join(t.split(".")[-depth:]) for t in ids}
        lowered = [n.lower() for n in names.values()]
        if len(set(lowered)) == len(lowered):
            break
    return names if ids else {}


def table_keys(info: Optional[dict]) -> list[dict]:
    """[{name, type, pk, fk}] for the primary and foreign key columns of a tables.get payload, in column order."""
    pk, fk = set(), set()
    for con in (info or {}).get("table_constraints") or []:
        pk |= {c.lower() for c in (con.get("primary_key_constraint") or {}).get("child_columns") or []}
        fk |= {c.lower() for c in (con.get("foreign_key_constraint") or {}).get("child_columns") or []}
    return [{"name": c["name"], "type": c.get("type_text") or c.get("type_name") or "", "pk": c["name"].lower() in pk, "fk": c["name"].lower() in fk}
            for c in (info or {}).get("columns") or [] if isinstance(c.get("name"), str) and c["name"].lower() in pk | fk]


def inputs(tables: list[str], edges: list[dict], object_of: Callable, joins_of: Callable) -> dict:
    """What an export reads besides the edges: {"keys": {table: key columns}, "cards": {edge id: cardinality}}.

    A cardinality the edge already carries (saved by an agent) wins over the one worked out from keys. object_of(table) is the tables.get data or None."""
    cards = {e["id"]: e["cardinality"] for e in edges if e.get("id") and e.get("cardinality")}
    todo = [e for e in edges if e.get("id") and e["id"] not in cards and e.get("kind") in cardinality.REFERENCE_KINDS]
    if todo:
        cards.update({k: v for k, v in cardinality.for_edges(todo, object_of, joins_of).items() if v})
    return {"keys": {t: table_keys(object_of(t)) for t in tables}, "cards": cards}


def facts_read(edges: list[dict], stats_times: Iterable[Optional[str]] = ()) -> Optional[str]:
    """The oldest time among the evidence shown (the edges' provenance and the cached size reads), as YYYY-MM-DD, or None when there is none."""
    times = [(e.get("provenance") or {}).get("fetched_at") for e in edges] + list(stats_times)
    times = [t for t in times if isinstance(t, str) and len(t) >= 10]
    return min(times)[:10] if times else None


def legend(lens: str, edges: list[dict], cards: dict, keys: dict) -> list[str]:
    """Twin of pictureLegend in web/src/graph/exportPicture.ts (tests/test_parity.py). What the picture's legend lists, and only what is drawn: the edge families, dashed, the crow's-foot ends and the key markers."""
    drawn = _drawn(lens, edges)
    families = {family_of(e.get("kind")) for e in drawn}
    out = []
    if "flow" in families:
        out.append("data flows")
    if "reference" in families:
        out.append("key reference")
    if any(is_inferred(e) for e in drawn):
        out.append("dashed: inferred or proposed")
    if any((cards.get(e.get("id")) or {}).get(side) for e in drawn if family_of(e.get("kind")) == "reference" for side in ("source", "target")):
        out.append(_END_TEXT)
    if lens == "model" and any(c["pk"] or c["fk"] for cols in keys.values() for c in cols):
        out.append("PK primary key, FK foreign key")
    return out


def _q(text) -> str:
    """A label Mermaid takes inside double quotes."""
    return str(text).replace('"', "#quot;")


def _sorted(edges: list[dict]) -> list[dict]:
    return sorted(edges, key=lambda e: (e["source"], e["target"], e.get("kind", ""), e.get("id", "")))


def flowchart(nodes: list[dict], edges: list[dict], glyphs: Optional[dict] = None) -> str:
    """A flowchart LR of the tables and their edges.

    Flow edges are arrows, labelled with the transform glyphs when glyphs ({edge id: [names]}) has them. Reference edges
    are plain lines labelled with the join columns. An inferred edge is dashed."""
    ids = sorted({n["id"] for n in nodes})
    name = short_names(ids)
    tag = {t: f"n{i}" for i, t in enumerate(ids, 1)}
    kinds = {n["id"]: n.get("kind") for n in nodes}
    lines = ["flowchart LR"]
    for t in ids:
        label = _q(name[t])
        k = kinds[t] or "table"
        lines.append(f'  {tag[t]}(["{label}"])' if k in ("view", "metric_view") else f'  {tag[t]}[["{label}"]]' if k in ("materialized_view", "streaming_table") else f'  {tag[t]}["{label}"]')
    for e in _sorted([e for e in _drawn("flow", edges) if e["source"] in tag and e["target"] in tag]):
        flow, dashed = family_of(e.get("kind")) == "flow", is_inferred(e)
        if flow:
            label = " ".join(GLYPHS[g] for g in (glyphs or {}).get(e.get("id"), []) if g in GLYPHS)
            arrow = ("<-.->" if dashed else "<-->") if e.get("bidir") else ("-.->" if dashed else "-->")
        else:
            label, arrow = e.get("label") or "", "-.-" if dashed else "---"
        lines.append(f'  {tag[e["source"]]} {arrow}|"{_q(label)}"| {tag[e["target"]]}' if label else f'  {tag[e["source"]]} {arrow} {tag[e["target"]]}')
    return "\n".join(lines) + "\n"


def _entity(name: str) -> str:
    out = re.sub(r"[^A-Za-z0-9_-]", "_", name)
    return out if re.match(r"[A-Za-z_]", out) else "t_" + out


def _word(text: str, fallback: str, sep: str = "") -> str:
    """One Mermaid word from a type or column name: a type loses its arguments, other characters become sep."""
    return re.sub(r"[^A-Za-z0-9_]", sep, re.split(r"[(<]", text or "")[0] if not sep else text or "") or fallback


def er_diagram(nodes: list[dict], edges: list[dict], keys: dict, cards: dict) -> str:
    """An erDiagram of the tables (key columns only) and their reference edges, with crow's-foot ends where they are known.

    The referenced table is written first. An end that is not known is drawn as zero or more, which claims nothing, and a comment says so."""
    ids = sorted({n["id"] for n in nodes})
    name = short_names(ids)
    ent = {t: _entity(name[t]) for t in ids}
    lines = ["erDiagram"]
    for t in ids:
        cols = keys.get(t) or []
        if not cols:
            lines.append(f"  {ent[t]}")
            continue
        lines.append(f"  {ent[t]} {{")
        for c in cols:
            tags = ", ".join(x for x, on in (("PK", c["pk"]), ("FK", c["fk"])) if on)
            lines.append(f"    {_word(c['type'], 'string')} {_word(c['name'], 'column', '_')} {tags}")
        lines.append("  }")
    unknown = []
    for e in _sorted([e for e in _drawn("model", edges) if e["source"] in ent and e["target"] in ent]):
        c = cards.get(e.get("id")) or {}
        s, t = (c.get("source") or {}).get("end"), (c.get("target") or {}).get("end")
        # The referenced table goes first: the target of a foreign key; for a join, the side that is known to be one.
        first_is_target = e.get("kind") == "fk" or not (s == "one" and t != "one")
        (a, ea), (b, eb) = ((e["target"], t), (e["source"], s)) if first_is_target else ((e["source"], s), (e["target"], t))
        if not s or not t:
            unknown.append(f"{name[e['source']]} -> {name[e['target']]}")
        label = e.get("label") or ", ".join(e.get("child_columns") or []) or "relates"
        lines.append(f'  {ent[a]} {_LEFT[ea or _UNKNOWN]}{".." if is_inferred(e) else "--"}{_RIGHT[eb or _UNKNOWN]} {ent[b]} : "{_q(label)}"')
    if unknown:
        lines.insert(1, "  %% ends not known (drawn as zero or more): " + "; ".join(sorted(set(unknown))))
    return "\n".join(lines) + "\n"


def mermaid(lens: str, nodes: list[dict], edges: list[dict], keys: Optional[dict] = None, cards: Optional[dict] = None, glyphs: Optional[dict] = None) -> str:
    """The Mermaid text of a graph for a lens: flow gives a flowchart, model an erDiagram."""
    if lens not in LENSES:
        raise ValueError(f"lens: expected one of {', '.join(LENSES)}")
    return flowchart(nodes, edges, glyphs) if lens == "flow" else er_diagram(nodes, edges, keys or {}, cards or {})


# ---------------------------------------------------------------- PNG

_INK, _FLOW, _REF, _MUTED = "#1f2328", "#2d3748", "#2c7a7b", "#6b7280"
_FILL = {"view": "#e6f0fa", "materialized_view": "#e9f5ea", "streaming_table": "#e9f5ea", "metric_view": "#f6ecf7"}


def _legend_rows(items: list[str]) -> list[list[str]]:
    """The legend in rows of up to three; a long line gets a row of its own, so it is not squeezed."""
    rows: list[list[str]] = []
    row: list[str] = []
    for text in items:
        if len(text) > 36:
            rows, row = rows + ([row] if row else []) + [[text]], []
        else:
            row.append(text)
            if len(row) == 3:
                rows, row = rows + [row], []
    return rows + ([row] if row else [])


def _clip(box, toward) -> tuple[float, float]:
    """Where the line from the box's center toward a point leaves the box."""
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    dx, dy = toward[0] - cx, toward[1] - cy
    if dx == dy == 0:
        return cx, cy
    k = min(((box[2] - box[0]) / 2) / abs(dx) if dx else 1e9, ((box[3] - box[1]) / 2) / abs(dy) if dy else 1e9)
    return cx + dx * k, cy + dy * k


def _dashed(d, a, b, fill, width, dash=7, gap=5):
    length = math.hypot(b[0] - a[0], b[1] - a[1]) or 1
    ux, uy = (b[0] - a[0]) / length, (b[1] - a[1]) / length
    pos = 0.0
    while pos < length:
        end = min(pos + dash, length)
        d.line([(a[0] + ux * pos, a[1] + uy * pos), (a[0] + ux * end, a[1] + uy * end)], fill=fill, width=width)
        pos += dash + gap


def _foot(d, p, toward, end: Optional[str], fill):
    """A crow's-foot end at p, the point on the table's edge; toward is the other table. An unknown end draws nothing."""
    if not end:
        return
    dx, dy = toward[0] - p[0], toward[1] - p[1]
    n = math.hypot(dx, dy) or 1
    ux, uy, px, py = dx / n, dy / n, -dy / n, dx / n
    at = lambda along, side=0: (p[0] + ux * along + px * side, p[1] + uy * along + py * side)
    if end in ("zero_many", "one_many"):  # the foot: three prongs from a point 9 along the line to the edge
        for side in (-5, 0, 5):
            d.line([at(9), at(0, side)], fill=fill, width=1)
    if end in ("one", "one_many"):
        for along in ((5, 8) if end == "one" else (11,)):
            d.line([at(along, -5), at(along, 5)], fill=fill, width=1)
    if end in ("zero_one", "zero_many"):
        c = at(15 if end == "zero_many" else 11)
        d.ellipse([c[0] - 3.5, c[1] - 3.5, c[0] + 3.5, c[1] + 3.5], fill="white", outline=fill)
    if end == "zero_one":
        d.line([at(5, -5), at(5, 5)], fill=fill, width=1)


def render_png(lens: str, nodes: list[dict], edges: list[dict], keys: dict, cards: dict, title: str, caption: str = "", read: Optional[str] = None, width: int = 1200) -> bytes:
    """A picture of the graph: the title and caption above, the tables and edges at their saved positions, the legend and the date below.

    Nodes carry x and y, their centers. The model lens lists each table's key columns and draws crow's-foot ends; the flow
    lens draws arrows. The picture is drawn at its natural size and shrunk to width when it is wider. Deterministic apart
    from the date, which is today's when the facts carry none."""
    from PIL import Image, ImageDraw, ImageFont

    width = int(min(max(width, 400), 4000))
    ids = {n["id"] for n in nodes}
    name = short_names(ids)
    drawn = [e for e in _drawn(lens, edges) if e["source"] in ids and e["target"] in ids]
    fonts: dict = {}

    def font(size):
        if size not in fonts:
            try:
                fonts[size] = ImageFont.load_default(size=size)
            except TypeError:
                fonts[size] = ImageFont.load_default()
        return fonts[size]
    body, small = font(11), font(10)
    rows = {n["id"]: [(("PK" if c["pk"] else ""), ("FK" if c["fk"] else ""), c["name"]) for c in keys.get(n["id"], [])] if lens == "model" else [] for n in nodes}
    tag_w = 26  # room for the PK and FK tags before a column name
    # The saved layout leaves room for a name, not for key rows: spread the centers by the height a box grows.
    sy = max(1.0, (24 + 15 * max((len(r) for r in rows.values()), default=0)) / 48)
    sx = 1.0 if lens == "flow" else 1.15
    boxes = {}
    for n in nodes:
        w = max([body.getlength(name[n["id"]]), *(tag_w + small.getlength(r[2]) for r in rows[n["id"]])]) + 18
        h = 24 + 15 * len(rows[n["id"]])
        cx, cy = n["x"] * sx, n["y"] * sy
        boxes[n["id"]] = (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)
    pad = 36
    x1, y1 = min((b[0] for b in boxes.values()), default=0), min((b[1] for b in boxes.values()), default=0)
    x2, y2 = max((b[2] for b in boxes.values()), default=100), max((b[3] for b in boxes.values()), default=60)
    items = legend(lens, drawn, cards, keys)
    rows_of_legend = _legend_rows(items)
    legend_rows = max(1, len(rows_of_legend))
    natural = int(max(x2 - x1 + 2 * pad, 640))
    head_h = 62 if caption else 44
    pic_h = int(y2 - y1 + 2 * pad)
    img = Image.new("RGB", (natural, head_h + pic_h + 24 + 22 * (legend_rows + 1)), "white")
    d = ImageDraw.Draw(img)
    d.text((pad, 14), title or "Graph", fill=_INK, font=font(20))
    if caption:
        d.text((pad, 42), caption, fill=_MUTED, font=font(13))
    sb = {t: (pad + b[0] - x1, head_h + pad + b[1] - y1, pad + b[2] - x1, head_h + pad + b[3] - y1) for t, b in boxes.items()}
    for e in sorted(drawn, key=lambda e: (e["source"], e["target"], e.get("id", ""))):
        a, b = sb[e["source"]], sb[e["target"]]
        pa, pb = _clip(a, ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)), _clip(b, ((a[0] + a[2]) / 2, (a[1] + a[3]) / 2))
        flow = family_of(e.get("kind")) == "flow"
        color, w = (_FLOW, 2) if flow else (_REF, 1)
        _dashed(d, pa, pb, color, w) if is_inferred(e) else d.line([pa, pb], fill=color, width=w)
        if flow:
            ang = math.atan2(pb[1] - pa[1], pb[0] - pa[0])
            d.polygon([pb, (pb[0] - 10 * math.cos(ang - 0.4), pb[1] - 10 * math.sin(ang - 0.4)), (pb[0] - 10 * math.cos(ang + 0.4), pb[1] - 10 * math.sin(ang + 0.4))], fill=color)
        else:
            c = cards.get(e.get("id")) or {}
            _foot(d, pa, pb, (c.get("source") or {}).get("end"), color)
            _foot(d, pb, pa, (c.get("target") or {}).get("end"), color)
    kinds = {n["id"]: n.get("kind") for n in nodes}
    for t in sorted(sb):
        b = sb[t]
        d.rounded_rectangle(b, radius=5, fill=_FILL.get(kinds[t], "#ffffff"), outline=_INK, width=1)
        d.text((b[0] + 8, b[1] + 6), name[t], fill=_INK, font=body)
        for i, (pk, fk, column) in enumerate(rows[t]):
            y = b[1] + 24 + 15 * i
            d.text((b[0] + 8, y), " ".join(x for x in (pk, fk) if x), fill=_REF, font=small)
            d.text((b[0] + 8 + tag_w, y), column, fill=_MUTED, font=small)
    ly = head_h + pic_h + 8
    d.line([(pad, ly - 4), (natural - pad, ly - 4)], fill="#d0d7de")
    for r, row in enumerate(rows_of_legend):
        for i, text in enumerate(row):
            x, y = pad + i * ((natural - 2 * pad) // 3), ly + 6 + r * 22
            if text in ("data flows", "key reference") or text.startswith("dashed"):
                if text == "data flows":
                    d.line([(x, y + 7), (x + 28, y + 7)], fill=_FLOW, width=2)
                elif text == "key reference":
                    d.line([(x, y + 7), (x + 28, y + 7)], fill=_REF, width=1)
                else:
                    _dashed(d, (x, y + 7), (x + 28, y + 7), _REF, 1)
                x += 36
            d.text((x, y), text, fill=_INK, font=font(12))
    when = f"Facts read {read}" if read else f"Exported {datetime.now(timezone.utc).date().isoformat()}"
    d.text((pad, ly + 6 + 22 * legend_rows), when, fill=_MUTED, font=font(12))
    if img.width > width:
        img = img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)
    out = BytesIO()
    img.save(out, "PNG")
    return out.getvalue()
