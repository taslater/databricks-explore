"""Canvas files under data/canvases/<name>.json, format versions 1 and 2.

The pydantic models mirror contracts/canvas.schema.json. Checks the schema cannot express
(unique window titles and ids, links and connectors that point at existing ids) run in check_references().
Validated bodies are stored exactly as received, so save followed by load returns the same object.
Version 2 adds the sketch node types and a top-level `edges` list of user-drawn connectors.
"""
import json
import os
from typing import Annotated, Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictFloat, StrictInt, ValidationError, model_validator
from pydantic_core import PydanticCustomError

import dbx

CANVASES = dbx.DATA / "canvases"
CANVASES.mkdir(parents=True, exist_ok=True)

NAME_PATTERN = r"^[A-Za-z0-9_.-]+$"


class CanvasInvalid(ValueError):
    """Validation failed. str(e) is '<path>: <reason>' (route returns it as HTTP 400)."""


class CanvasNotFound(LookupError):
    """No stored canvas with that name (route returns HTTP 404)."""


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


def save_canvas(data) -> str:
    """Validate and write data/canvases/<name>.json, storing the body exactly as received."""
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
    tmp = path.parent / (path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)  # overwrite; never leaves a half-written file behind
    return name


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
