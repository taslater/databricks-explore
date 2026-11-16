"""Search terms with dotted paths and globs: split `cat.schema.name`, turn `*` and `?` into LIKE patterns, and match in Python."""
import re
from dataclasses import dataclass

ESCAPE = "!"  # the LIKE escape character: not a backslash, which Databricks string literals treat as an escape


def split_segments(text):
    """Split on dots outside backticks. Returns the segments with the backticks removed: `a.b`.c -> ["a.b", "c"]."""
    segments, current, quoted = [], [], False
    for ch in text:
        if ch == "`":
            quoted = not quoted
        elif ch == "." and not quoted:
            segments.append("".join(current))
            current = []
        else:
            current.append(ch)
    segments.append("".join(current))
    return segments


def has_glob(segment):
    """True when the segment holds a `*` (any run) or `?` (one character)."""
    return "*" in segment or "?" in segment


def like_pattern(segment, anchored):
    """A lowercase LIKE pattern for a segment: `*` -> %, `?` -> _, literal %, _ and ! escaped with `!`.

    Unanchored (and no glob) wraps the text in % so it matches anywhere in the name.
    """
    out = []
    for ch in segment.lower():
        if ch == "*":
            out.append("%")
        elif ch == "?":
            out.append("_")
        elif ch in ("%", "_", ESCAPE):
            out.append(ESCAPE + ch)
        else:
            out.append(ch)
    body = "".join(out)
    return body if anchored or has_glob(segment) else f"%{body}%"


def like_matches(pattern, text):
    """Python twin of `lower(text) LIKE pattern ESCAPE '!'`, for the demo and the cache search."""
    regex, i = [], 0
    while i < len(pattern):
        ch = pattern[i]
        if ch == ESCAPE and i + 1 < len(pattern):
            i += 1
            regex.append(re.escape(pattern[i]))
        elif ch == "%":
            regex.append(".*")
        elif ch == "_":
            regex.append(".")
        else:
            regex.append(re.escape(ch))
        i += 1
    return re.fullmatch("".join(regex), text.lower(), re.S) is not None


@dataclass(frozen=True)
class SearchTerm:
    """What a search box holds: optional catalog and schema (exact, case-insensitive, unless they use a glob) and a name."""
    catalog: str | None
    schema: str | None
    name: str

    @property
    def simple(self):
        """True for plain text: no path and no glob, so the old substring search applies unchanged."""
        return self.catalog is None and self.schema is None and not has_glob(self.name)

    def patterns(self):
        """The LIKE patterns to use, as {"cat", "sch", "q"} holding only the parts that filter anything."""
        out = {}
        if self.catalog:
            out["cat"] = like_pattern(self.catalog, anchored=True)
        if self.schema:
            out["sch"] = like_pattern(self.schema, anchored=True)
        if self.name:
            out["q"] = like_pattern(self.name, anchored=False)
        return out

    def matches(self, catalog, schema, name):
        """True when a table with these three parts satisfies every part of the term."""
        got = {"cat": catalog, "sch": schema, "q": name}
        return all(like_matches(p, got[k]) for k, p in self.patterns().items())


def parse_term(text):
    """Parse a search box into a SearchTerm.

    One segment is a name. `x.y` is schema and name, `x.` is a catalog, `x.y.` is catalog and schema,
    and `x.y.z` is catalog, schema and name (anything after a third segment is ignored).
    """
    segs = split_segments(text.strip())
    if len(segs) == 1:
        return SearchTerm(None, None, segs[0])
    if len(segs) == 2:
        return SearchTerm(segs[0], None, "") if segs[1] == "" else SearchTerm(None, segs[0], segs[1])
    return SearchTerm(segs[0], segs[1], segs[2])
