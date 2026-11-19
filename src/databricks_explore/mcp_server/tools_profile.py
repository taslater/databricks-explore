"""The tool that measures one relationship on the warehouse (relprofile.py): a plan without confirm, the measurement with it."""
import json

from .. import cardinality
from .. import dbx
from .. import relationships
from .. import relprofile

from .sqlguard import NotReadOnly, check_read_only
from .tooling import B, FORMAT, ToolError, obj, text, tool

TABLE = {"type": "string", "minLength": 1, "description": "full name catalog.schema.table"}
_END_MARK = {"one": "||", "zero_one": "o|", "one_many": "|<", "zero_many": "o<"}


def _spec(ctx, source: str, target: str, kind):
    """The profiling spec of source -> target for `kind` (else the first kind with a known key: foreign key, manual, mined). Raises ToolError."""
    e = ctx.need_explorer()

    def object_of(t):
        try:
            return e.object(t)["data"]
        except Exception:
            return None
    kinds = [kind] if kind else ["fk", "manual", "join_mined"]
    reasons = []
    with ctx.store() as store:
        for k in kinds:
            specs, skipped = relprofile.plan_edges([{"id": f"{k}:{source}->{target}", "kind": k, "source": source, "target": target}], object_of,
                                                   lambda t: relationships.join_keys(store, t, object_of(t)))
            if specs:
                return specs[0]
            reasons += [f"{k}: {s['reason']}" for s in skipped]
    raise ToolError(f"Cannot profile {source} -> {target}: " + "; ".join(reasons) + ". Add the relationship (add_relationship) or check get_relationships.")


def _summary(p: dict) -> str:
    src, tgt = relprofile.ends(p)
    lines = [f"{p['source']}.({', '.join(a for a, _ in p['pairs'])}) -> {p['target']}.({', '.join(b for _, b in p['pairs'])}), measured {p['measured_at']}",
             f"rows in source {p['a_rows']:,} ({p['a_null_rows']:,} with a null key, {p['a_distinct_keys']:,} distinct keys); rows in target {p['b_rows']:,}, {p['b_distinct_keys']:,} distinct keys, {p['b_repeated_keys']:,} repeated",
             f"orphans: {p['orphan_rows']:,} rows, {p['orphan_keys']:,} keys; unused target keys: {p['unused_keys']:,}; rows per source key: max {p['max_fanout']:,}, p95 {p['p95_fanout']:,}",
             f"ends: {p['source'].rsplit('.', 1)[-1]} {_END_MARK[src['end']]}, {p['target'].rsplit('.', 1)[-1]} {_END_MARK[tgt['end']]} (the Graph draws these from now on)"]
    lines += [s for s in (relprofile.orphan_sentence(p), relprofile.not_a_key_sentence(p)) if s]
    return "\n".join(lines)


@tool("profile_relationship", "Measure one reference relationship (a foreign key, manual or mined join) on the SQL warehouse: rows and null keys in the source, distinct and repeated keys in the target, orphans (source keys with no match), unused target keys and rows per key. Without confirm: true it runs nothing and shows the read-only SQL and the table sizes known so far. With it, the statement runs through the selected warehouse, and the result is kept with its date: the Graph then draws the measured crow's-foot ends and, when there are orphans, a red tick. Use it only for a question the metadata cannot answer.",
      obj({"source": TABLE, "target": TABLE, "kind": {"type": "string", "enum": ["fk", "join_mined", "manual"], "description": "which known key to use (default: the first of foreign key, manual, mined)"},
           "confirm": {**B, "description": "true to run the statement; without it the tool only plans"}, "format": FORMAT}, ("source", "target")), read_only=False)
def profile_relationship(ctx, args):
    spec = _spec(ctx, args["source"], args["target"], args.get("kind"))
    e = ctx.need_explorer()
    if args.get("confirm") is not True:
        return text(f"Nothing ran. Pass confirm: true to run this on warehouse {e.warehouse_id or '(none selected)'}.\nkind {spec['kind']}, key "
                    + ", ".join(f"{a} = {b}" for a, b in spec["pairs"]) + f"\n{spec['sql']}")
    try:
        check_read_only(spec["sql"])
    except NotReadOnly as err:  # the statement is generated, so this is a guard against a bug rather than a user mistake
        raise ToolError(f"Rejected: {err}") from err
    if not e.warehouse_id:
        raise ToolError("No SQL warehouse is selected: pick one in the app first.")
    try:
        p = relprofile.run(e.sql, spec["source"], spec["target"], [tuple(x) for x in spec["pairs"]])
    except Exception as err:
        raise ToolError(f"The profiling statement failed: {dbx.clean_error(err)}") from err
    relprofile.put(e.profile, spec["kind"], spec["source"], spec["target"], p)
    if args.get("format") == "json":
        return text(json.dumps({"kind": spec["kind"], "profile": p, "cardinality": relprofile.as_cardinality(p)}, separators=(",", ":")))
    return text(_summary(p))
