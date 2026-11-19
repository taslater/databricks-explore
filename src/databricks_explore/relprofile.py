"""Profile a relationship: one read-only statement that measures how A.(k) -> B.(k) behaves, the ends it gives, and where the result is kept.

The statement counts rows and keys on both sides, the keys of A with no match in B (orphans) and the keys of B nothing uses,
and the rows per key of A. It never changes data. The result is evidence with a date: it is kept per profile in
data/relationships/<profile>.profiles.json, keyed by (kind, source, target) so a derived foreign key and a stored join keep
it alike, and replaces the ends read from metadata (basis `profile`)."""
import hashlib
import json
import os
from typing import Callable, Optional

from . import cardinality, dbx
from .tablestats import quoted

MAX_EDGES = 10  # relationships profiled by one request
NUMBERS = ("a_rows", "a_null_rows", "a_distinct_keys", "b_rows", "b_distinct_keys", "b_repeated_keys", "orphan_rows", "orphan_keys",
           "unused_keys", "max_fanout", "p95_fanout")
_KEY_SOURCE = {"fk": "fk", "join_mined": "mined", "manual": "manual"}  # the join key source each edge kind reads
_RANK = {"fk": 0, "manual": 1, "mined": 2}


def _q(column: str) -> str:
    return "`" + column.replace("`", "``") + "`"


def build_sql(source: str, target: str, pairs: list[tuple[str, str]]) -> str:
    """The profiling statement for source.(a columns) -> target.(b columns). A row with a null in any key column is not matched (as a foreign key is not checked then)."""
    a, b = quoted(source), quoted(target)
    ac, bc = [_q(x) for x, _ in pairs], [_q(y) for _, y in pairs]

    def keys(table, cols):
        select = ", ".join(f"{c} AS k{i}" for i, c in enumerate(cols))
        return f"SELECT {select}, count(*) AS n FROM {table} WHERE {' AND '.join(c + ' IS NOT NULL' for c in cols)} GROUP BY {', '.join(cols)}"
    on = " AND ".join(f"a.k{i} = b.k{i}" for i in range(len(pairs)))
    return (f"WITH a_keys AS ({keys(a, ac)}),\n"
            f"b_keys AS ({keys(b, bc)}),\n"
            f"a_all AS (SELECT count(*) AS a_rows, count_if({' OR '.join(c + ' IS NULL' for c in ac)}) AS a_null_rows FROM {a})\n"
            "SELECT t.a_rows AS a_rows, t.a_null_rows AS a_null_rows, ak.a_distinct_keys AS a_distinct_keys,\n"
            "       bk.b_rows AS b_rows, bk.b_distinct_keys AS b_distinct_keys, bk.b_repeated_keys AS b_repeated_keys,\n"
            "       o.orphan_rows AS orphan_rows, o.orphan_keys AS orphan_keys, u.unused_keys AS unused_keys,\n"
            "       ak.max_fanout AS max_fanout, ak.p95_fanout AS p95_fanout\n"
            "FROM a_all t\n"
            "CROSS JOIN (SELECT count(*) AS a_distinct_keys, max(n) AS max_fanout, percentile_approx(n, 0.95) AS p95_fanout FROM a_keys) ak\n"
            "CROSS JOIN (SELECT coalesce(sum(n), 0) AS b_rows, count(*) AS b_distinct_keys, count_if(n > 1) AS b_repeated_keys FROM b_keys) bk\n"
            f"CROSS JOIN (SELECT count(*) AS orphan_keys, coalesce(sum(a.n), 0) AS orphan_rows FROM a_keys a LEFT ANTI JOIN b_keys b ON {on}) o\n"
            f"CROSS JOIN (SELECT count(*) AS unused_keys FROM b_keys b LEFT ANTI JOIN a_keys a ON {on}) u")


def key_pairs(kind: Optional[str], joins: Optional[dict], target: str) -> Optional[list[tuple[str, str]]]:
    """The column pairs (source column, target column) to profile: the first usable key of `join_keys(source)` towards `target`.

    Rejected keys and keys of another source than the edge's kind are not used (any source when `kind` is None, foreign keys first)."""
    found = next((j for j in (joins or {}).get("joins") or [] if j["table"].lower() == target.lower()), None)
    want = _KEY_SOURCE.get(kind or "")
    keys = [k for k in (found or {}).get("keys") or [] if k["pairs"] and k["status"] != "rejected" and (want is None or k["source"] == want)
            and (want or k["source"] in _RANK)]
    keys.sort(key=lambda k: _RANK.get(k["source"], 9))
    return [(p["here"], p["there"]) for p in keys[0]["pairs"]] if keys else None


def plan_edges(edges: list[dict], object_of, joins_of) -> tuple[list[dict], list[dict]]:
    """(profilable, skipped) for graph edges ({id, kind, source, target}): each profilable one is {id, kind, source, target, pairs, sql}.

    `object_of(table)` is the table's `tables.get` data or None, and `joins_of(table)` its `relationships.join_keys`. Skipped ones are
    {id, reason}: not a reference edge, a table that cannot be read, a view (it has no rows to key on is fine, so views are allowed), or no known key."""
    out, skipped = [], []
    for e in edges:
        kind, s, t = e.get("kind"), e.get("source"), e.get("target")
        if kind not in cardinality.REFERENCE_KINDS:
            skipped.append({"id": e["id"], "reason": "not a reference edge (only foreign keys, mined joins and manual edges have keys)"})
        elif s.lower() == t.lower():
            skipped.append({"id": e["id"], "reason": "a table's reference to itself is not profiled"})
        elif object_of(s) is None or object_of(t) is None:
            skipped.append({"id": e["id"], "reason": "cannot read the table"})
        else:
            pairs = key_pairs(kind, joins_of(s), t)
            if pairs is None:
                skipped.append({"id": e["id"], "reason": "no usable key between the two tables"})
            else:
                out.append({"id": e["id"], "kind": kind, "source": s, "target": t, "pairs": [list(p) for p in pairs], "sql": build_sql(s, t, pairs)})
    return out, skipped


def _int(value) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def make(source: str, target: str, pairs: list[tuple[str, str]], sql: str, row: dict, measured_at: str) -> dict:
    """The stored profile from the statement's one row. Raises ValueError when the row lacks a number."""
    missing = [n for n in NUMBERS if n not in row]
    if missing:
        raise ValueError("the warehouse answer has no " + ", ".join(missing))
    return {"source": source, "target": target, "pairs": [list(p) for p in pairs], **{n: _int(row[n]) for n in NUMBERS},
            "measured_at": measured_at, "sql_hash": hashlib.sha256(sql.encode()).hexdigest()[:16]}


def run(sql_fn: Callable, source: str, target: str, pairs: list[tuple[str, str]]) -> dict:
    """Run the statement through `sql_fn` (Explorer.sql) and return the profile. Raises when it fails or answers nothing."""
    sql = build_sql(source, target, pairs)
    rows = sql_fn(sql)
    if not rows:
        raise ValueError("the warehouse answered no row")
    return make(source, target, pairs, sql, rows[0], dbx.now())


def _short(table: str) -> str:
    return table.rsplit(".", 1)[-1]


def percent(part: int, whole: int) -> str:
    """`1.2%`, or `<0.1%` for a share too small to show."""
    if whole <= 0 or part <= 0:
        return "0%"
    p = 100 * part / whole
    return "<0.1%" if p < 0.1 else f"{p:.1f}%" if p < 10 else f"{p:.0f}%"


def target_unique(p: dict) -> bool:
    """Whether the target's key is unique: no key value appears twice."""
    return p["b_repeated_keys"] == 0


def orphan_sentence(p: dict) -> Optional[str]:
    """E.g. "1.2% of fact_order_lines (223,204 rows, 212 keys) have no match in dim_product". None when there are no orphans."""
    if p["orphan_rows"] <= 0:
        return None
    return (f"{percent(p['orphan_rows'], p['a_rows'])} of {_short(p['source'])} ({p['orphan_rows']:,} rows, {p['orphan_keys']:,} keys) "
            f"have no match in {_short(p['target'])}")


def not_a_key_sentence(p: dict) -> Optional[str]:
    """E.g. "not a key: 214 customer_id values appear more than once in customers". None when the target's key is unique."""
    if target_unique(p):
        return None
    cols = ", ".join(b for _, b in p["pairs"])
    return f"not a key: {p['b_repeated_keys']:,} {cols} values appear more than once in {_short(p['target'])}"


def ends(p: dict) -> tuple[dict, dict]:
    """(source end, target end) from the numbers.

    At the target: how many target rows one source row has. One when the target's key is unique, many when it is not; zero
    allowed when some source rows have a null key or no match. At the source: one or more when every key of the target is
    used, else zero or more."""
    zero = p["a_null_rows"] > 0 or p["orphan_rows"] > 0
    unique = target_unique(p)
    tgt = {True: ("zero_one", "one"), False: ("zero_many", "one_many")}[unique][0 if zero else 1]
    src = "one_many" if p["unused_keys"] == 0 and p["b_distinct_keys"] > 0 else "zero_many"
    when = p["measured_at"][:10]
    t_why = f"measured {when}: {p['b_distinct_keys']:,} distinct keys in {_short(p['target'])}, " + ("none repeated" if unique else f"{p['b_repeated_keys']:,} repeated")
    s_why = f"measured {when}: " + (f"every key of {_short(p['target'])} is used" if src == "one_many" else f"{p['unused_keys']:,} keys of {_short(p['target'])} are not used")
    return {"end": src, "basis": "profile", "why": s_why}, {"end": tgt, "basis": "profile", "why": t_why}


def as_cardinality(p: dict) -> dict:
    """The crow's-foot ends of a measured relationship, in the shape of cardinality.edge_cardinality, with the profile itself under `profile`."""
    src, tgt = ends(p)
    nulls = f"{p['a_null_rows']:,} rows of {_short(p['source'])} have a null key" if p["a_null_rows"] else None
    extra = [s for s in (not_a_key_sentence(p), nulls, orphan_sentence(p)) if s]
    sentence = " ".join([cardinality.sentence(p["source"], p["target"], src, tgt), *(s[0].upper() + s[1:] + "." for s in extra)])
    return {"source": src, "target": tgt, "sentence": sentence, "profile": p}


# ---------- where profiles are kept ----------

def path(profile: str):
    """data/relationships/<profile>.profiles.json."""
    return dbx.DATA / "relationships" / f"{dbx.safe(profile)}.profiles.json"


def _key(kind: str, source: str, target: str) -> str:
    return "|".join((kind, source.lower(), target.lower()))


def load(profile: str) -> dict:
    """Every kept profile, {"kind|source|target": profile}. Empty when there are none."""
    try:
        data = json.loads(path(profile).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def get(profile: str, kind: str, source: str, target: str) -> Optional[dict]:
    """The kept profile of one relationship, or None."""
    return load(profile).get(_key(kind, source, target))


def put(profile: str, kind: str, source: str, target: str, p: dict) -> None:
    """Keep (replace) the profile of one relationship."""
    data = load(profile)
    data[_key(kind, source, target)] = p
    out = path(profile)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
    os.replace(tmp, out)


def lookup(profile: str) -> Callable[[str, str, str], Optional[dict]]:
    """A `profile_of(kind, source, target)` for cardinality.for_edges that reads the file once."""
    data = load(profile)
    return lambda kind, source, target: data.get(_key(kind, source, target))
