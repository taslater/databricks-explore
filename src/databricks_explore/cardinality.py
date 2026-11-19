"""Crow's-foot ends of a reference edge (foreign key, mined join, manual join), from keys and nullability. Never queries.

An end is drawn only when it is known: a plain end would read as "one". Each end sits at one table and says how many of
that table's rows relate to one row of the other: `one` (||), `zero_one` (o|), `one_many` (|<) or `zero_many` (o<).
Metadata gives these (a measured end from a profile would replace one, with basis `profile`):
- A foreign key's parent end, when its columns are the parent's primary key: `one` when every FK column is NOT NULL,
  else `zero_one`. Its child end is `zero_many`, or `zero_one` when the FK columns are also the child's primary key.
- A join with no constraint (mined, manual): an end is `one` only when that side's join columns are exactly its primary key.
Several key sets between the same tables give an end only when every set gives the same one."""
from typing import Optional

REFERENCE_KINDS = ("fk", "join_mined", "manual")
_KEY_SOURCE = {"fk": "fk", "join_mined": "mined", "manual": "manual"}  # the join key source each edge kind reads
_PHRASE = {"one": "exactly one row", "zero_one": "zero or one row", "one_many": "one or more rows", "zero_many": "zero or more rows"}


def _lower(cols) -> frozenset:
    return frozenset(c.lower() for c in cols)


def primary_key(info: Optional[dict]) -> Optional[frozenset]:
    """The lowercased primary key columns from a table's `tables.get` data, or None when it declares none."""
    for con in (info or {}).get("table_constraints") or []:
        pk = con.get("primary_key_constraint")
        if pk and pk.get("child_columns"):
            return _lower(pk["child_columns"])
    return None


def _not_null(info: Optional[dict], cols) -> bool:
    flags = {str(c.get("name", "")).lower(): c.get("nullable") for c in (info or {}).get("columns") or []}
    return all(flags.get(c.lower()) is False for c in cols)


def _end(end: str, basis: str, why: str) -> dict:
    return {"end": end, "basis": basis, "why": why}


def _ends_for_set(kind: str, src_cols, tgt_cols, src_info, tgt_info) -> tuple[Optional[dict], Optional[dict]]:
    """(source end, target end) for one key set: columns read from the source and the target table."""
    src_pk, tgt_pk = primary_key(src_info), primary_key(tgt_info)
    if kind == "fk":
        target = source = None
        if tgt_pk is not None and _lower(tgt_cols) == tgt_pk:
            if _not_null(src_info, src_cols):
                target = _end("one", "constraint", "foreign key to the primary key, NOT NULL on " + ", ".join(src_cols))
            else:
                target = _end("zero_one", "constraint", "foreign key to the primary key, nullable " + ", ".join(src_cols))
        if src_pk is not None and _lower(src_cols) == src_pk:
            source = _end("zero_one", "primary_key", "the foreign key columns are also the primary key")
        else:
            source = _end("zero_many", "constraint", "nothing says every row has a match")
        return source, target
    source = _end("one", "primary_key", "the join columns are the primary key") if src_pk is not None and _lower(src_cols) == src_pk else None
    target = _end("one", "primary_key", "the join columns are the primary key") if tgt_pk is not None and _lower(tgt_cols) == tgt_pk else None
    return source, target


def _agree(ends: list[Optional[dict]]) -> Optional[dict]:
    first = ends[0] if ends else None
    return first if first and all(e and e["end"] == first["end"] for e in ends) else None


def edge_cardinality(kind: str, source: str, target: str, key_sets: list[list[tuple[str, str]]],
                     source_info: Optional[dict], target_info: Optional[dict]) -> Optional[dict]:
    """{"source": end or None, "target": end or None, "sentence"} for a reference edge, or None when no end is known.

    `key_sets` are the join columns, one list of (source column, target column) per key set; `*_info` is each table's `tables.get` data."""
    if kind not in REFERENCE_KINDS or not key_sets:
        return None
    per_set = [_ends_for_set(kind, [a for a, _ in ks], [b for _, b in ks], source_info, target_info) for ks in key_sets]
    src, tgt = _agree([s for s, _ in per_set]), _agree([t for _, t in per_set])
    if not src and not tgt:
        return None
    return {"source": src, "target": tgt, "sentence": sentence(source, target, src, tgt)}


def sentence(source: str, target: str, src: Optional[dict], tgt: Optional[dict]) -> str:
    """E.g. "Each row of `orders` has exactly one row of `customers` (foreign key to the primary key, NOT NULL on customer_id). ..." """
    short = lambda t: t.rsplit(".", 1)[-1]
    parts = []
    # The end at the target says how many target rows one source row has, and the end at the source the other way round.
    for end, here, other in ((tgt, target, source), (src, source, target)):
        if end:
            parts.append(f"Each row of `{short(other)}` has {_PHRASE[end['end']]} of `{short(here)}` ({end['why']}).")
    return " ".join(parts)


def for_edges(edges: list[dict], object_of, joins_of, profile_of=None) -> dict[str, Optional[dict]]:
    """{edge id: cardinality or None} for graph edges ({id, kind, source, target}); other kinds are left out.

    An edge between two columns (source_column and target_column too) reads only the key sets that hold that pair, so each
    pair of a composite key shows the ends of its key and a mined pair is not blurred by other mined keys.

    `object_of(table)` is the table's `tables.get` data or None; `joins_of(table)` is `relationships.join_keys` for it
    (or None). `profile_of(kind, source, target)` is a kept measurement (relprofile) or None: it replaces the ends read from metadata."""
    from . import relprofile  # relprofile imports this module
    infos: dict[str, Optional[dict]] = {}
    joins: dict[str, Optional[dict]] = {}

    def info(t):
        if t not in infos:
            infos[t] = object_of(t)
        return infos[t]

    def join(t):
        if t not in joins:
            joins[t] = joins_of(t)
        return joins[t]
    out: dict[str, Optional[dict]] = {}
    for e in edges:
        kind, s, t = e.get("kind"), e.get("source"), e.get("target")
        if kind not in REFERENCE_KINDS or not isinstance(s, str) or not isinstance(t, str):
            continue
        measured = profile_of(kind, s, t) if profile_of else None
        if measured:
            out[e["id"]] = relprofile.as_cardinality(measured)
            continue
        found = next((j for j in (join(s) or {}).get("joins") or [] if j["table"].lower() == t.lower()), None)
        keys = [k for k in (found or {}).get("keys") or [] if k["source"] == _KEY_SOURCE[kind] and k["status"] != "rejected" and k["pairs"]]
        sc, tc = e.get("source_column"), e.get("target_column")
        if isinstance(sc, str) and isinstance(tc, str):
            keys = [k for k in keys if any(p["here"].lower() == sc.lower() and p["there"].lower() == tc.lower() for p in k["pairs"])]
        out[e["id"]] = edge_cardinality(kind, s, t, [[(p["here"], p["there"]) for p in k["pairs"]] for k in keys], info(s), info(t))
    return out
