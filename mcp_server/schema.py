"""A small JSON Schema checker for tool arguments: type, enum, const, bounds, items, properties, required, no extra keys."""
from typing import Any

_TYPES = {
    "string": lambda v: isinstance(v, str),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "array": lambda v: isinstance(v, list),
    "object": lambda v: isinstance(v, dict),
    "null": lambda v: v is None,
}


def validate(value: Any, schema: dict, path: str = "arguments") -> list[str]:
    """Every way `value` breaks `schema`, as messages that name the path. Empty when it is fine."""
    errors: list[str] = []
    if "anyOf" in schema and not any(not validate(value, alt, path) for alt in schema["anyOf"]):
        return [f"{path}: does not match any allowed form ({'; '.join(_describe(a) for a in schema['anyOf'])})"]
    want = schema.get("type")
    if want is not None:
        kinds = want if isinstance(want, list) else [want]
        if not any(_TYPES[k](value) for k in kinds):
            return [f"{path}: expected {' or '.join(kinds)}, got {_name(value)}"]
    if "const" in schema and value != schema["const"]:
        errors.append(f"{path}: must be {schema['const']!r}")
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: must be one of {', '.join(map(str, schema['enum']))}")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{path}: must be at least {schema['minimum']}")
        if "exclusiveMinimum" in schema and value <= schema["exclusiveMinimum"]:
            errors.append(f"{path}: must be greater than {schema['exclusiveMinimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            errors.append(f"{path}: must be at most {schema['maximum']}")
    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            errors.append(f"{path}: must not be empty" if schema["minLength"] == 1 else f"{path}: too short")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            errors.append(f"{path}: longer than {schema['maxLength']} characters")
    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            errors.append(f"{path}: needs at least {schema['minItems']} item(s)")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            errors.append(f"{path}: at most {schema['maxItems']} items")
        for i, item in enumerate(value):
            if "items" in schema:
                errors += validate(item, schema["items"], f"{path}[{i}]")
    if isinstance(value, dict):
        props = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{path}: missing required field {key!r}")
        for key, item in value.items():
            if key in props:
                errors += validate(item, props[key], f"{path}.{key}")
            elif schema.get("additionalProperties") is False:
                errors.append(f"{path}: unknown field {key!r} (known: {', '.join(props) or 'none'})")
    return errors


def _name(v: Any) -> str:
    return "null" if v is None else type(v).__name__


def _describe(schema: dict) -> str:
    kind = schema.get("type", "value")
    return " or ".join(kind) if isinstance(kind, list) else kind
