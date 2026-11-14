"""What a tool is: the registry, the decorator that adds one, the context handlers get, and the error they raise."""
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

REGISTRY: dict[str, "Tool"] = {}


class ToolError(Exception):
    """A tool could not do what was asked. The message goes back to the agent as an error result."""


@dataclass
class Context:
    """The app's connection state, as the tools see it. The tools never connect, and never choose a profile."""
    explorer: Callable[[], Any]                      # the connected Explorer, or None
    store: Callable[[], Any]                         # the relationship store of the connected profile (a context manager)
    miner: Callable[[], Any]                         # the Miner of the connected Explorer
    extra: dict = field(default_factory=dict)

    def need_explorer(self):
        """The connected Explorer, or a ToolError that tells the agent to ask the person to connect."""
        e = self.explorer()
        if e is None:
            raise ToolError("Not connected: connect a profile in the app first. The agent cannot connect or choose a profile.")
        return e


@dataclass
class Tool:
    name: str
    description: str
    schema: dict
    handler: Callable[[Context, dict], Any]
    read_only: bool = True
    destructive: bool = False

    def listing(self) -> dict:
        """The tools/list entry."""
        return {"name": self.name, "description": self.description, "inputSchema": self.schema,
                "annotations": {"readOnlyHint": self.read_only, "destructiveHint": self.destructive,
                                "idempotentHint": False, "openWorldHint": False}}


def obj(properties: Optional[dict] = None, required: tuple = ()) -> dict:
    """An input schema: an object with exactly these properties."""
    return {"type": "object", "properties": properties or {}, "required": list(required), "additionalProperties": False}


S = {"type": "string"}
B = {"type": "boolean"}
FORMAT = {"type": "string", "enum": ["text", "json"], "description": "text (default, compact) or json (everything)"}


def integer(minimum: int, maximum: int, description: str = "") -> dict:
    """A bounded integer property."""
    return {"type": "integer", "minimum": minimum, "maximum": maximum, **({"description": description} if description else {})}


def strings(description: str = "") -> dict:
    """A list of strings property."""
    return {"type": "array", "items": S, **({"description": description} if description else {})}


def tool(name: str, description: str, schema: dict, read_only: bool = True, destructive: bool = False):
    """Register a handler `fn(ctx, args) -> str | list of MCP content blocks` as a tool."""
    def add(fn):
        REGISTRY[name] = Tool(name, description, schema, fn, read_only, destructive)
        return fn
    return add


def text(s: str) -> list[dict]:
    """One MCP text block."""
    return [{"type": "text", "text": s}]
