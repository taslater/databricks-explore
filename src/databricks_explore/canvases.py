"""Canvas files under data/canvases/<name>.json, format versions 1 and 2.

The pydantic models mirror contracts/canvas.schema.json. Checks the schema cannot express
(unique window titles and ids, links and connectors that point at existing ids) run in check_references().
Validated bodies are stored exactly as received, so save followed by load returns the same object.
Version 2 adds the sketch node types and a top-level `edges` list of user-drawn connectors.
Each canvas also has a revision number (a counter in data/canvas_history/<name>/meta.json, never inside the canvas file)
that every save bumps, and agent writes keep the replaced file as a snapshot so they can be undone.
"""
import json
import os
import threading
from datetime import datetime, timezone
from typing import Annotated, Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictFloat, StrictInt, StrictStr, ValidationError, model_validator
from pydantic_core import PydanticCustomError

from . import dbx

CANVASES = dbx.DATA / "canvases"
CANVASES.mkdir(parents=True, exist_ok=True)

NAME_PATTERN = r"^[A-Za-z0-9_.-]+$"
KEEP_SNAPSHOTS = 20  # per canvas
LOCK = threading.RLock()  # one writer at a time, so an agent's read-modify-write cannot interleave with a save


class CanvasInvalid(ValueError):
    """Validation failed. str(e) is '<path>: <reason>' (route returns it as HTTP 400)."""


class CanvasNotFound(LookupError):
    """No stored canvas with that name (route returns HTTP 404)."""


class CanvasConflict(RuntimeError):
    """The canvas was saved by someone else since the revision the writer started from (route returns HTTP 409).

    `info` is what revision_info() says now, so the page can offer Reload or Keep mine."""

    def __init__(self, name: str, expected: int, info: dict):
        super().__init__(f"canvas {name} was saved by {info['by'] or 'someone else'} since revision {expected} (now revision {info['revision']})")
        self.info = info


class Point(BaseModel):
    model_config = ConfigDict(extra="forbid")
    x: StrictFloat
    y: StrictFloat


class Size(BaseModel):
    model_config = ConfigDict(extra="forbid")
    w: Annotated[StrictFloat, Field(gt=0)]
    h: Annotated[StrictFloat, Field(gt=0)]


class Viewport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    x: StrictFloat
    y: StrictFloat
    zoom: Annotated[StrictFloat, Field(gt=0)]


class Chart(BaseModel):
    vega_lite: dict[str, Any]


MAX_RESULT_ROWS = 500          # most rows a window's saved result keeps
MAX_RESULT_BYTES = 256 * 1024  # about this much JSON (the rows and columns), so a canvas file stays small


class ResultColumn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    type: str = ""
    type_text: Optional[str] = None


class ResultSnapshot(BaseModel):
    """The result a query window last ran, kept in the canvas file so a reader sees evidence without pressing Run."""
    model_config = ConfigDict(extra="forbid")
    columns: list[ResultColumn]
    rows: Annotated[list[list[Optional[StrictStr]]], Field(max_length=MAX_RESULT_ROWS)]
    row_count: Annotated[StrictInt, Field(ge=0)]
    truncated: StrictBool
    ran_at: Annotated[str, Field(min_length=1)]
    sql_hash: Annotated[str, Field(min_length=1)]


def result_snapshot(result: dict, sql_hash: str, ran_at: Optional[str] = None) -> dict:
    """A window's `result` field from a finished statement (the Result shape of GET /api/query/<id>).

    Keeps at most MAX_RESULT_ROWS rows and about MAX_RESULT_BYTES of JSON (rows are dropped from the end until it fits).
    `row_count` is how many rows the run returned and `truncated` is true when the run was cut at its row limit or
    this function kept fewer rows than the run returned."""
    columns = [{"name": c["name"], "type": c.get("type") or "", **({"type_text": c["type_text"]} if c.get("type_text") else {})}
               for c in result.get("columns", [])]
    rows = [[None if v is None else str(v) for v in row] for row in result.get("rows", [])][:MAX_RESULT_ROWS]
    total = result.get("row_count", len(result.get("rows", [])))
    size = len(json.dumps(columns, separators=(",", ":")))
    kept = 0
    for row in rows:
        size += len(json.dumps(row, separators=(",", ":"))) + 1
        if size > MAX_RESULT_BYTES:
            break
        kept += 1
    return {"columns": columns, "rows": rows[:kept], "row_count": total, "truncated": bool(result.get("truncated")) or kept < total,
            "ran_at": ran_at or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "sql_hash": sql_hash}


WindowType = Literal["query", "chart", "note", "table", "shape", "text", "sticky", "frame", "placeholder"]
REQUIRED_BY_TYPE = {"query": "sql", "chart": "chart", "note": "text", "table": "table",
                    "shape": "shape", "placeholder": "placeholder"}
SKETCH_TYPES = ("shape", "text", "sticky", "frame", "placeholder")  # version 2 only; titled by `label`, not `title`
ShapeKind = Literal["rect", "rounded", "ellipse", "diamond", "cylinder"]
LineKind = Literal["straight", "step", "curve"]


class PlaceholderColumn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    type: str = ""
    key: Optional[Literal["pk", "fk"]] = None


class Placeholder(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: Annotated[str, Field(pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")]
    name: str
    columns: list[PlaceholderColumn] = Field(default_factory=list)
    linked: Optional[Annotated[str, Field(min_length=1)]] = None


class Window(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: Annotated[str, Field(min_length=1)]
    type: WindowType
    title: Optional[Annotated[str, Field(min_length=1, pattern=r"^[^{}]+$")]] = None
    position: Point
    size: Size
    sql: Optional[str] = None
    chart: Optional[Chart] = None
    text: Optional[str] = None
    table: Optional[Annotated[str, Field(min_length=1)]] = None
    collapsed: StrictBool = False
    label: Optional[str] = None
    shape: Optional[ShapeKind] = None
    fill: Optional[str] = None
    stroke: Optional[str] = None
    font_size: Optional[Annotated[StrictFloat, Field(gt=0)]] = None
    locked: Optional[StrictBool] = None
    z: Optional[StrictFloat] = None
    placeholder: Optional[Placeholder] = None
    result: Optional[ResultSnapshot] = None
    view: Optional[Literal["results", "chart"]] = None

    @model_validator(mode="after")
    def _type_needs_its_field(self):
        if self.type not in SKETCH_TYPES and self.title is None:
            raise PydanticCustomError("type_requires_field", 'type "{type}" requires "{field}"',
                                      {"type": self.type, "field": "title"})
        field = REQUIRED_BY_TYPE.get(self.type)
        if field is not None and getattr(self, field) is None:
            raise PydanticCustomError("type_requires_field", 'type "{type}" requires "{field}"',
                                      {"type": self.type, "field": field})
        return self


class Link(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    from_: Annotated[str, Field(alias="from", min_length=1)]
    to: Annotated[str, Field(min_length=1)]


class RelationshipRef(BaseModel):
    """What a connector remembers about the `sketch` edge saved from it (all optional)."""
    model_config = ConfigDict(extra="forbid")
    id: Optional[Annotated[str, Field(min_length=1)]] = None
    source_column: Optional[Annotated[str, Field(min_length=1)]] = None
    target_column: Optional[Annotated[str, Field(min_length=1)]] = None


class CanvasEdge(BaseModel):
    """A user-drawn connector between two nodes. Version 2 only."""
    model_config = ConfigDict(extra="forbid")
    id: Annotated[str, Field(min_length=1)]
    source: Annotated[str, Field(min_length=1)]
    target: Annotated[str, Field(min_length=1)]
    source_handle: Optional[Literal["t", "r", "b", "l"]] = None
    target_handle: Optional[Literal["t", "r", "b", "l"]] = None
    line: LineKind = "step"
    arrow_start: StrictBool = False
    arrow_end: StrictBool = True
    dashed: StrictBool = False
    label: Optional[str] = None
    label_offset: StrictFloat = 0.0
    color: Optional[str] = None
    relationship: Optional[RelationshipRef] = None


class Canvas(BaseModel):
    model_config = ConfigDict(extra="allow")
    version: Annotated[StrictInt, Field(ge=1, le=2)]
    name: Annotated[str, Field(min_length=1, pattern=NAME_PATTERN)]
    profile: Optional[Annotated[str, Field(min_length=1)]] = None
    warehouse_id: Optional[str] = None
    viewport: Optional[Viewport] = None
    windows: list[Window]
    links: list[Link] = Field(default_factory=list)
    edges: list[CanvasEdge] = Field(default_factory=list)


def _path(loc):
    out = ""
    for part in loc:
        out += f"[{part}]" if isinstance(part, int) else (f".{part}" if out else str(part))
    return out or "(root)"


def check_references(canvas: Canvas) -> None:
    """Checks the schema cannot express: unique titles and ids, and links and connectors that name existing ids."""
    if canvas.version == 1:
        if canvas.profile is None:
            raise CanvasInvalid('profile: required in version 1')
        if "edges" in canvas.model_fields_set:
            raise CanvasInvalid('edges: needs version 2')
    ids, titles = {}, {}
    for i, w in enumerate(canvas.windows):
        if canvas.version == 1 and w.type in SKETCH_TYPES:
            raise CanvasInvalid(f'windows[{i}].type: "{w.type}" needs version 2')
        if w.id in ids:
            raise CanvasInvalid(f'windows[{i}].id: duplicate id "{w.id}"')
        ids[w.id] = i
        if w.type in SKETCH_TYPES:
            continue  # sketch nodes are not referenced from SQL, so their labels need not be unique
        if w.title in titles:
            raise CanvasInvalid(f'windows[{i}].title: duplicate title "{w.title}"')
        titles[w.title] = i
    for i, link in enumerate(canvas.links):
        for key, value in (("from", link.from_), ("to", link.to)):
            if value not in ids:
                raise CanvasInvalid(f'links[{i}].{key}: no window with id "{value}"')
    edge_ids = set()
    for i, edge in enumerate(canvas.edges):
        if edge.id in edge_ids:
            raise CanvasInvalid(f'edges[{i}].id: duplicate id "{edge.id}"')
        edge_ids.add(edge.id)
        for key, value in (("source", edge.source), ("target", edge.target)):
            if value not in ids:
                raise CanvasInvalid(f'edges[{i}].{key}: no window with id "{value}"')


def parse_canvas(data) -> Canvas:
    """Validate a canvas body. Raises CanvasInvalid with a path-prefixed message."""
    if not isinstance(data, dict):
        raise CanvasInvalid("(root): body must be a JSON object")
    try:
        canvas = Canvas.model_validate(data)
    except ValidationError as e:
        first = e.errors()[0]
        raise CanvasInvalid(f"{_path(first['loc'])}: {first['msg']}") from e
    check_references(canvas)
    return canvas


def path_for(name: str):
    return CANVASES / f"{dbx.safe(name)}.json"


def list_canvases() -> list[str]:
    return sorted(p.stem for p in CANVASES.glob("*.json"))


def history_dir(name: str):
    """data/canvas_history/<name>/: the revision counter and the snapshots of one canvas."""
    return CANVASES.parent / "canvas_history" / dbx.safe(name)


def _meta(name: str) -> dict:
    try:
        meta = json.loads((history_dir(name) / "meta.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return meta if isinstance(meta, dict) else {}


def _snapshots(name: str) -> list:
    d = history_dir(name)
    return sorted(d.glob("[0-9]*.json")) if d.is_dir() else []


def _atomic_write(path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.parent / (path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)  # overwrite; never leaves a half-written file behind


def revision_info(name: str) -> dict:
    """{"name", "revision", "by", "snapshots"} for a saved canvas. `by` is ui, agent or undo (None before any save)."""
    with LOCK:
        if dbx.safe(name) != name or not path_for(name).is_file():
            raise CanvasNotFound(f"canvas not found: {name}")
        meta = _meta(name)
        rev = meta.get("revision")
        return {"name": name, "revision": rev if isinstance(rev, int) else 0, "by": meta.get("by"),
                "snapshots": len(_snapshots(name))}


def write_canvas(data, by: str = "ui", snapshot: bool = False, expect: Optional[int] = None) -> tuple[str, int]:
    """Validate and write data/canvases/<name>.json, storing the body exactly as received. Returns (name, revision).

    Every write bumps the revision and records who made it (`by`). With `snapshot`, the file being replaced is kept
    first (the newest KEEP_SNAPSHOTS are kept), which is what undo_canvas restores. With `expect`, the write is refused
    (CanvasConflict) when the canvas exists and is not at that revision, so a page cannot overwrite an agent's newer save unseen.
    """
    name = parse_canvas(data).name
    # On Windows (and macOS by default) "Hours" and "hours" are the same file. Refuse
    # rather than silently overwrite a different canvas.
    clash = [s for s in list_canvases() if s.lower() == name.lower() and s != name]
    if clash:
        raise CanvasInvalid(f"name: '{name}' differs from existing canvas '{clash[0]}' only by case; pick another name")
    try:
        text = json.dumps(data, indent=2, allow_nan=False)
    except ValueError as e:  # NaN or Infinity cannot be stored as JSON
        raise CanvasInvalid(f"(root): {e}") from e
    path = path_for(name)
    with LOCK:
        meta = _meta(name)
        old = meta.get("revision") if isinstance(meta.get("revision"), int) else 0
        if expect is not None and path.is_file() and old != expect:
            raise CanvasConflict(name, expect, revision_info(name))
        if snapshot and path.is_file():
            _atomic_write(history_dir(name) / f"{old:08d}.json", path.read_text(encoding="utf-8"))
            for stale in _snapshots(name)[:-KEEP_SNAPSHOTS]:
                stale.unlink(missing_ok=True)
        _atomic_write(path, text)
        _atomic_write(history_dir(name) / "meta.json", json.dumps({"revision": old + 1, "by": by}))
        return name, old + 1


def save_canvas(data) -> str:
    """Validate and write data/canvases/<name>.json, storing the body exactly as received."""
    return write_canvas(data)[0]


def undo_canvas(name: str) -> dict:
    """Put back the newest snapshot of a canvas (the state before an agent's last write) and drop that snapshot.

    Returns {"name", "revision", "snapshots"} (snapshots left). CanvasInvalid when there is nothing to undo.
    """
    with LOCK:
        revision_info(name)  # CanvasNotFound for an unknown canvas
        snaps = _snapshots(name)
        if not snaps:
            raise CanvasInvalid(f"nothing to undo for canvas {name}")
        data = json.loads(snaps[-1].read_text(encoding="utf-8"))
        _, rev = write_canvas(data, by="undo")
        snaps[-1].unlink(missing_ok=True)
        return {"name": name, "revision": rev, "snapshots": len(_snapshots(name))}


def load_canvas(name: str) -> dict:
    """Return the stored canvas object as saved. Validates it on the way out."""
    if dbx.safe(name) != name:  # names are validated on save, so this cannot exist
        raise CanvasNotFound(f"canvas not found: {name}")
    path = path_for(name)
    if not path.is_file():
        raise CanvasNotFound(f"canvas not found: {name}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise CanvasInvalid(f"(root): stored file is not valid JSON: {e}") from e
    canvas = parse_canvas(data)
    if canvas.name != name:
        raise CanvasInvalid(f'name: "{canvas.name}" does not match file name "{name}"')
    return data
