"""Concepts: a small business glossary over the catalog. Request bodies, links, search, candidates and tag suggestions.

The data (concepts, and concept_link edges to tables, columns and other concepts) lives in the relationship store,
see relationships.py. Everything here works on an open Store. Nothing here calls Databricks: the tag suggestions take
the rows of a query the route ran, and candidates read only the local cache.
"""
import re
import uuid
from typing import Annotated, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

import dbx
import relationships as rel
from relationships import Concept, ConceptProvenance, Endpoint, Provenance, RelationshipInvalid

TAG_ROW_CAP = 20000
MAX_CANDIDATES = 200
SYSTEM_TAG_PREFIX = "system."  # governed tags Databricks owns, such as system.certification_status
_CONCEPT = "concept:"

# Every Unity Catalog tag, at all four levels, as one row each: scope, where it sits, and the key and value.
TAG_SQL = """SELECT 'catalog' AS scope, catalog_name, CAST(NULL AS STRING) AS schema_name,
       CAST(NULL AS STRING) AS table_name, CAST(NULL AS STRING) AS column_name, tag_name, tag_value
FROM system.information_schema.catalog_tags
UNION ALL
SELECT 'schema', catalog_name, schema_name, CAST(NULL AS STRING), CAST(NULL AS STRING), tag_name, tag_value
FROM system.information_schema.schema_tags
UNION ALL
SELECT 'table', catalog_name, schema_name, table_name, CAST(NULL AS STRING), tag_name, tag_value
FROM system.information_schema.table_tags
UNION ALL
SELECT 'column', catalog_name, schema_name, table_name, column_name, tag_name, tag_value
FROM system.information_schema.column_tags"""


# ---------- request bodies ----------

class ConceptCreate(BaseModel):
    """Body of POST /api/concepts."""
    model_config = ConfigDict(extra="forbid")
    name: Annotated[str, Field(min_length=1, max_length=200)]
    definition: str = ""
    synonyms: list[str] = Field(default_factory=list)
    domain: Optional[str] = None
    status: Literal["draft", "reviewed", "certified"] = "draft"
    tags: list[str] = Field(default_factory=list)


class ConceptPatch(BaseModel):
    """Body of PATCH /api/concepts/<id>: any of the editable fields."""
    model_config = ConfigDict(extra="forbid")
    name: Optional[Annotated[str, Field(min_length=1, max_length=200)]] = None
    definition: Optional[str] = None
    synonyms: Optional[list[str]] = None
    domain: Optional[str] = None
    status: Optional[Literal["draft", "reviewed", "certified"]] = None
    tags: Optional[list[str]] = None


class LinkCreate(BaseModel):
    """Body of POST /api/concepts/<id>/links: a table, a column (table plus column) or concept:<uuid>, and a relation."""
    model_config = ConfigDict(extra="forbid")
    target: Endpoint
    relation: str
    note: str = ""


def parse_create(data):
    """Validate a POST /api/concepts body."""
    return rel._parse(ConceptCreate, data)


def parse_patch(data):
    """Validate a PATCH body: at least one field."""
    patch = rel._parse(ConceptPatch, data)
    if not patch.model_fields_set:
        raise RelationshipInvalid("(root): give at least one field to change")
    for field in ("name", "definition", "synonyms", "status", "tags"):
        if field in patch.model_fields_set and getattr(patch, field) is None:
            raise RelationshipInvalid(f"{field}: cannot be null")
    return patch


def parse_link(data):
    """Validate a link body, including that the relation fits the target (table or column, or concept)."""
    body = rel._parse(LinkCreate, data)
    to_concept = body.target.table.startswith(_CONCEPT)
    if body.target.table.startswith("ph:"):
        raise RelationshipInvalid("target.table: a concept links to a table, a column or a concept")
    allowed = rel.CONCEPT_RELATIONS if to_concept else rel.TABLE_RELATIONS
    if body.relation not in allowed:
        raise RelationshipInvalid(f"relation: a link to {'a concept' if to_concept else 'a table or column'} "
                                  f"is one of {', '.join(allowed)}")
    return body


def check_concept_id(cid):
    """A concept id from a URL, normalized; RelationshipNotFound when it is not even a uuid."""
    try:
        return str(uuid.UUID(cid))
    except ValueError:
        raise rel.RelationshipNotFound(f"concept not found: {cid}") from None


# ---------- concepts ----------

def create(store, body):
    """Add a manual concept. Returns it. A name already taken (any case) is RelationshipInvalid."""
    now = dbx.now()
    concept = Concept(**body.model_dump(), provenance=ConceptProvenance(origin="manual", fetched_at=now),
                      created_at=now, updated_at=now)
    return store.save_concept(concept)[0]


def update(store, cid, patch):
    """Change the given fields of a concept."""
    old = store.concept(cid)
    fields = patch.model_dump(exclude_unset=True)
    new = Concept(**{**old.model_dump(), **fields, "updated_at": dbx.now()})
    return store.save_concept(new)[0]


def _matches(c, q):
    q = q.casefold()
    return q in c.name.casefold() or q in c.definition.casefold() or any(q in s.casefold() for s in c.synonyms)


def listing(store, q="", domain=None, status=None):
    """Concepts by name, optionally those matching text in name, synonyms or definition, a domain and a status.

    Returns {"concepts": [concept + link_count], "domains": every domain in use}.
    """
    if status and status not in rel.CONCEPT_STATUSES:
        raise RelationshipInvalid(f"status: must be one of {', '.join(rel.CONCEPT_STATUSES)}")
    everything = store.concepts()
    counts = store.link_counts()
    out = [c for c in everything
           if (not q.strip() or _matches(c, q.strip()))
           and (not domain or (c.domain or "").casefold() == domain.casefold())
           and (not status or c.status == status)]
    domains = {}
    for c in everything:
        if c.domain:
            domains.setdefault(c.domain.casefold(), c.domain)  # the first spelling stands for its case variants
    return {"concepts": [{**c.model_dump(mode="json"), "link_count": counts.get(c.id, 0)} for c in out],
            "domains": sorted(domains.values(), key=str.casefold)}


def detail(store, cid):
    """A concept with the links that start at it and the concept-to-concept links that point at it."""
    c = store.concept(cid)
    return {**c.model_dump(mode="json"),
            "links": [e.model_dump(mode="json") for e in store.concept_links(cid)],
            "incoming": [e.model_dump(mode="json") for e in store.concept_links(cid, incoming=True)]}


def remove(store, cid):
    """Delete a concept and its links, both ways. Returns {"deleted", "links_removed"}."""
    return {"deleted": cid, "links_removed": store.delete_concept(cid)}


# ---------- links ----------

def add_link(store, cid, body):
    """Link a concept to a table, a column or another concept. Linking again changes the relation. Returns (edge, created)."""
    store.concept(cid)
    now = dbx.now()
    edge = rel.Edge(kind="concept_link", source=Endpoint(table=_CONCEPT + cid), target=body.target, directed=True,
                    provenance=Provenance(origin="user", fetched_at=now), status="accepted", note=body.note,
                    relation=body.relation)
    return store.upsert(edge)


def remove_link(store, cid, edge_id):
    """Remove one link of this concept (outgoing or incoming). RelationshipNotFound if it is not one."""
    edge = store.get(edge_id)
    mine = _CONCEPT + cid
    if edge.kind != "concept_link" or mine not in (edge.source.table, edge.target.table):
        raise rel.RelationshipNotFound(f"link not found: {edge_id}")
    store.delete(edge_id)
    return {"deleted": edge_id}


def for_tables(store, tables):
    """The concepts linked to any of these tables, with those links (target table or one of its columns)."""
    links = store.links_to_tables(tables)
    ids = list(dict.fromkeys(e.source.table[len(_CONCEPT):] for e in links))
    found = {c.id: c for c in store.concepts() if c.id in ids}
    links = [e for e in links if e.source.table[len(_CONCEPT):] in found]
    return {"concepts": [found[i].model_dump(mode="json") for i in ids if i in found],
            "links": [e.model_dump(mode="json") for e in links]}


# ---------- candidates: tables and columns whose names or comments mention the concept ----------

def _norm(text):
    return " ".join(re.findall(r"[a-z0-9]+", (text or "").lower()))


def _term_pattern(term):
    """A whole-word pattern over normalized text, with a plural allowed on the last word."""
    return re.compile(r"(?<![a-z0-9])" + re.escape(_norm(term)) + r"(?:s|es)?(?![a-z0-9])")


def candidates(store, cid, metadata):
    """Cached tables and columns whose name or comment mentions the concept's name or a synonym.

    `metadata` is dbx.cached_metadata(). A name hit outranks a comment hit. Only whole words match, with a plural
    allowed (`customer` finds `dim_customers`, not `customerid`). Each hit says whether the concept already links to it.
    Returns {"terms", "hits", "searched": {"tables", "tables_with_columns", "columns"}, "truncated"}.
    """
    c = store.concept(cid)
    terms = [t for t in dict.fromkeys([c.name, *c.synonyms]) if _norm(t)]
    patterns = [(t, _term_pattern(t)) for t in terms]
    linked = {(e.target.table, e.target.column) for e in store.concept_links(cid)}
    hits, cols = [], 0

    def check(table, column, name, comment):
        best = None
        for field, text, score in (("name", name, 3), ("comment", comment, 1)):
            norm = _norm(text)
            for term, pat in patterns:
                if norm and pat.search(norm) and (best is None or score > best["score"]):
                    best = {"kind": "column" if column else "table", "table": table, "column": column,
                            "field": field, "matched": term, "text": text, "score": score,
                            "linked": (table, column) in linked}
        if best:
            hits.append(best)

    for t in metadata:
        check(t["table"], None, t["table"].split(".")[-1], t.get("comment"))
        for col in t.get("columns") or []:
            cols += 1
            check(t["table"], col["name"], col["name"], col.get("comment"))
    hits.sort(key=lambda h: (-h["score"], h["linked"], h["table"], h["column"] or ""))
    return {"terms": terms, "hits": hits[:MAX_CANDIDATES], "truncated": len(hits) > MAX_CANDIDATES,
            "searched": {"tables": len(metadata), "tables_with_columns": sum(1 for t in metadata if t.get("columns") is not None),
                         "columns": cols}}


# ---------- suggestions from Unity Catalog tags ----------

def tag_plan(warehouse_id=None):
    """The read-only SQL a tag suggestion run executes, for a confirm dialog. Nothing runs."""
    return {"queries": [{"name": "uc_tags", "sql": TAG_SQL}], "row_cap": TAG_ROW_CAP, "warehouse_id": warehouse_id}


def _tag_name(key, value):
    return f"{key}={value}" if value else key


def _rows(result):
    names = [c["name"] for c in result.get("columns") or []]
    return [dict(zip(names, r)) for r in result.get("rows") or []]


def tag_run(store, result):
    """Turn the rows of TAG_SQL into draft concepts, one per tag key and value, linked with `describes`.

    A concept made by an earlier run (origin uc_tag, same key and value) is updated, never duplicated: its
    definition, status and anything a person edited stay, links to newly tagged tables and columns are added, and links
    this run made to things no longer tagged are removed. A link a person made to the same target is left alone.
    Catalog and schema tags have no table or column to link, so they only add a line to the definition.
    Tags whose name starts with `system.` are skipped (listed under `skipped`): the app shows certification as a badge.
    Returns {"created": [...], "updated": [...], "skipped": [...], "rows", "truncated"}; each created or updated
    entry is {"id", "name", "links_added", "links_removed", "links"}.
    """
    groups, system = {}, {}
    for r in _rows(result):
        key, value = (r.get("tag_name") or "").strip(), (r.get("tag_value") or "").strip()
        if not key:
            continue
        if key.startswith(SYSTEM_TAG_PREFIX):
            system[(key, value)] = True
            continue
        g = groups.setdefault((key, value), {"targets": {}, "scopes": []})
        scope = r.get("scope")
        if scope in ("table", "column") and r.get("table_name"):
            table = f"{r['catalog_name']}.{r['schema_name']}.{r['table_name']}"
            g["targets"][(table, r.get("column_name") if scope == "column" else None)] = True
        elif scope in ("catalog", "schema"):
            g["scopes"].append(f"{scope} {r['catalog_name']}" + (f".{r['schema_name']}" if scope == "schema" else ""))
    now = dbx.now()
    existing = {c.provenance.source_ref: c for c in store.concepts() if c.provenance.origin == "uc_tag"}
    taken = {c.name.casefold() for c in store.concepts()}
    created, updated = [], []
    skipped = [{"name": _tag_name(k, v), "reason": "a Databricks system tag, shown as a badge instead"}
               for k, v in sorted(system)]
    for (key, value), g in sorted(groups.items()):
        ref = _tag_name(key, value)
        wanted = [(Endpoint(table=t, column=col)) for (t, col) in g["targets"]]
        concept = existing.get(ref)
        if concept is None:
            name = ref
            if name.casefold() in taken:
                name = f"{ref} (UC tag)"
            if name.casefold() in taken:
                skipped.append({"name": ref, "reason": "a concept with this name already exists"})
                continue
            taken.add(name.casefold())
            where = f" Also set on {', '.join(g['scopes'][:5])}" + (" and more." if len(g["scopes"]) > 5 else ".") \
                if g["scopes"] else ""
            concept = store.save_concept(Concept(
                name=name, definition=f"Unity Catalog tag {ref}.{where}", tags=[key],
                provenance=ConceptProvenance(origin="uc_tag", source_ref=ref, fetched_at=now)))[0]
            bucket = created
        else:
            concept = store.save_concept(concept.model_copy(update={
                "provenance": concept.provenance.model_copy(update={"fetched_at": now}), "updated_at": now}))[0]
            bucket = updated
        have = {(e.target.table, e.target.column): e for e in store.concept_links(concept.id)}
        new = [rel.Edge(kind="concept_link", source=Endpoint(table=_CONCEPT + concept.id), target=ep, directed=True,
                        provenance=Provenance(origin="uc_tag", source_ref=ref, fetched_at=now), status="accepted",
                        relation="describes")
               for ep in wanted if (ep.table, ep.column) not in have]
        stale = [e.id for k, e in have.items()
                 if e.provenance.origin == "uc_tag" and e.provenance.source_ref == ref
                 and (k[0], k[1]) not in g["targets"]]
        store.upsert_edges(new)
        store.delete_edges(stale)
        bucket.append({"id": concept.id, "name": concept.name, "links_added": len(new), "links_removed": len(stale),
                       "links": len(have) + len(new) - len(stale)})
    return {"created": created, "updated": updated, "skipped": skipped, "rows": len(_rows(result)),
            "truncated": bool(result.get("truncated"))}
