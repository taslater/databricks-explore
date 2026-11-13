"""Canvas files under data/canvases/<name>.json.

The pydantic models mirror contracts/canvas.schema.json. Checks the schema cannot express
(unique window titles and ids, links that point at existing ids) run in check_references().
Validated bodies are stored exactly as received, so save followed by load returns the same object.
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


WindowType = Literal["query", "chart", "note", "table"]
REQUIRED_BY_TYPE = {"query": "sql", "chart": "chart", "note": "text", "table": "table"}


class Window(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: Annotated[str, Field(min_length=1)]
    type: WindowType
    title: Annotated[str, Field(min_length=1, pattern=r"^[^{}]+$")]
    position: Point
    size: Size
    sql: Optional[str] = None
    chart: Optional[Chart] = None
    text: Optional[str] = None
    table: Optional[Annotated[str, Field(min_length=1)]] = None
    collapsed: StrictBool = False

    @model_validator(mode="after")
    def _type_needs_its_field(self):
        field = REQUIRED_BY_TYPE[self.type]
        if getattr(self, field) is None:
            raise PydanticCustomError("type_requires_field", 'type "{type}" requires "{field}"',
                                      {"type": self.type, "field": field})
        return self


class Link(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    from_: Annotated[str, Field(alias="from", min_length=1)]
    to: Annotated[str, Field(min_length=1)]


class Canvas(BaseModel):
    model_config = ConfigDict(extra="allow")
    version: Annotated[StrictInt, Field(ge=1, le=1)]
    name: Annotated[str, Field(min_length=1, pattern=NAME_PATTERN)]
    profile: Annotated[str, Field(min_length=1)]
    warehouse_id: Optional[str] = None
    viewport: Optional[Viewport] = None
    windows: list[Window]
    links: list[Link] = Field(default_factory=list)


def _path(loc):
    out = ""
    for part in loc:
        out += f"[{part}]" if isinstance(part, int) else (f".{part}" if out else str(part))
    return out or "(root)"


def check_references(canvas: Canvas) -> None:
    """Checks the schema cannot express: unique titles and ids, and links that name existing ids."""
    ids, titles = {}, {}
    for i, w in enumerate(canvas.windows):
        if w.id in ids:
            raise CanvasInvalid(f'windows[{i}].id: duplicate id "{w.id}"')
        ids[w.id] = i
        if w.title in titles:
            raise CanvasInvalid(f'windows[{i}].title: duplicate title "{w.title}"')
        titles[w.title] = i
    for i, link in enumerate(canvas.links):
        for key, value in (("from", link.from_), ("to", link.to)):
            if value not in ids:
                raise CanvasInvalid(f'links[{i}].{key}: no window with id "{value}"')


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
