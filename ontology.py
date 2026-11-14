"""Import from Databricks: Genie Ontology domains and pages, metric view measures and dimensions, and certification.

Read-only. There is no export of an ontology, so the parts that can be read are read one by one: Domains and Pages
through the REST API (both Beta, so every field is read defensively), metric views through the tables API after a SQL
lookup, and the `system.certification_status` tag through the tag tables. Everything lands as concepts with origin
`ontology` (see concepts.py and relationships.py); a rerun matches by `provenance.source_ref`.
"""
import json
import re
from pathlib import Path

import yaml
from databricks.sdk import errors
from pydantic import ValidationError

import concepts
import dbx
import relationships as rel
from relationships import Concept, ConceptProvenance, Endpoint, Provenance

DOMAINS_PATH = "/api/2.0/domains"
PAGES_PATH = "/api/2.0/knowledge/pages"
TABLE_PATH = "/api/2.1/unity-catalog/tables/{full_name}"
MAX_REQUESTS = 100  # pages of one list, so a server that repeats a token cannot loop forever
VIEW_CAP = 500
CERT_ROW_CAP = 20000
CERT_TAG = "system.certification_status"
CERT_VALUES = ("certified", "deprecated")
CERT_CACHE = "certification.json"  # under the profile's cache folder, next to the catalog metadata
UNAVAILABLE = "not available on this workspace"
FIELDS = ("name", "definition", "synonyms", "domain", "status")
_BLANK = ("", [], None)

METRIC_VIEWS_SQL = """SELECT table_catalog, table_schema, table_name
FROM system.information_schema.tables
WHERE table_type = 'METRIC_VIEW'
ORDER BY table_catalog, table_schema, table_name"""

CERT_SQL = f"""SELECT 'table' AS scope, catalog_name, schema_name, table_name, CAST(NULL AS STRING) AS column_name, tag_value
FROM system.information_schema.table_tags
WHERE tag_name = '{CERT_TAG}'
UNION ALL
SELECT 'column', catalog_name, schema_name, table_name, column_name, tag_value
FROM system.information_schema.column_tags
WHERE tag_name = '{CERT_TAG}'"""


def plan(warehouse_id=None):
    """Every REST call and SQL statement an import run makes, for a confirm dialog. Nothing runs."""
    return {"steps": [
        {"id": "domains", "kind": "rest", "label": "Genie Ontology domains (Beta)", "method": "GET", "path": DOMAINS_PATH,
         "paginated": True},
        {"id": "pages", "kind": "rest", "label": "Genie Ontology pages (Beta)", "method": "GET", "path": PAGES_PATH,
         "paginated": True},
        {"id": "metric_views", "kind": "sql", "label": "Metric views, through the selected SQL warehouse",
         "sql": METRIC_VIEWS_SQL},
        {"id": "metric_definitions", "kind": "rest", "label": "Each metric view's definition, once per view found",
         "method": "GET", "path": TABLE_PATH, "paginated": False},
        {"id": "certification", "kind": "sql",
         "label": "Certification tags (system.certification_status), through the selected SQL warehouse; refreshes the local cache",
         "sql": CERT_SQL},
    ], "row_cap": VIEW_CAP, "warehouse_id": warehouse_id}


# ---------- reading ----------

def _get(d, *keys):
    """The first of these keys the dict has with a value (snake_case and camelCase spellings both appear)."""
    for k in keys:
        if isinstance(d, dict) and d.get(k) is not None:
            return d[k]
    return None


def _text(v):
    return v.strip() if isinstance(v, str) else ""


def _strings(v):
    """A list of trimmed non-empty strings from a list (anything else gives none)."""
    return rel._clean_list([s for s in v if isinstance(s, str)]) if isinstance(v, list) else []


def _items(resp, *keys):
    """The records of one list response: under one of these keys, else the first list, else the list itself."""
    if isinstance(resp, list):
        found = resp
    elif isinstance(resp, dict):
        found = next((resp[k] for k in keys if isinstance(resp.get(k), list)), None)
        if found is None:
            found = next((v for v in resp.values() if isinstance(v, list)), [])
    else:
        found = []
    return [x for x in found if isinstance(x, dict)]


def _fetch_all(ex, path, *keys):
    """Every record of a paginated list, following next_page_token."""
    items, token = [], None
    for _ in range(MAX_REQUESTS):
        resp = dbx.api_get(ex, path, {"page_token": token} if token else None)
        items.extend(_items(resp, *keys))
        token = _get(resp, "next_page_token", "nextPageToken")
        if not token or not isinstance(token, str):
            break
    return items


def _unavailable(e):
    """True for a 403 or 404: the Beta endpoint is not there, or not for this user or workspace."""
    if isinstance(e, (errors.NotFound, errors.PermissionDenied)):
        return True
    if getattr(e, "status_code", None) in (403, 404):
        return True
    return bool(re.search(r"\b40[34]\b|not found|permission denied|forbidden", str(e), re.I))


def _failure(e):
    if _unavailable(e):
        return {"status": "unavailable", "message": UNAVAILABLE}
    return {"status": "failed", "message": dbx.clean_error(e)}


def _domain_labels(domains):
    """Every way a page can name a domain (id, name, tag key, with or without `domains/`) to the domain's label."""
    labels = {}
    for d in domains:
        label = _text(_get(d, "display_name", "displayName", "title")) or _text(_get(d, "tag_key", "tagKey"))
        if not label:
            continue
        for key in (_get(d, "domain_id", "domainId"), _get(d, "name"), _get(d, "tag_key", "tagKey")):
            if isinstance(key, str) and key:
                labels[key] = labels[key.split("/")[-1]] = label
                labels[f"domains/{key.split('/')[-1]}"] = label
    return labels


def _page_domain(labels, page):
    raw = _text(_get(page, "domain", "domain_name", "domainName"))
    if not raw:
        return None
    return labels.get(raw) or labels.get(raw.split("/")[-1]) or raw.split("/")[-1] or None


def _page_spec(page, labels):
    """A concept spec from one page, or (None, reason)."""
    ref = _text(_get(page, "name"))
    label = _text(_get(page, "display_name", "displayName", "title"))
    if not ref:
        return None, "the page has no name to match it by"
    if not label:
        return None, "the page has no display_name"
    description, body = _text(_get(page, "description")), _text(_get(page, "body"))
    definition = "\n\n".join(p for p in dict.fromkeys([description, body]) if p)
    state = _text(_get(page, "state")).upper()
    return {"ref": ref, "kind": "page", "name": label, "alt": f"{label} (ontology)", "definition": definition,
            "synonyms": _strings(_get(page, "synonyms")), "domain": _page_domain(labels, page) or None,
            "status": "reviewed" if state == "PUBLISHED" else "draft", "tags": [], "links": []}, None


def parse_metric_view(text):
    """Measures and dimensions from a metric view's YAML: dicts of kind, name, label, comment and synonyms.

    ValueError says why a definition cannot be used. Entries without a name are dropped.
    """
    try:
        doc = yaml.safe_load(text or "")
    except yaml.YAMLError as e:
        raise ValueError(f"the definition is not valid YAML ({str(e).splitlines()[0] if str(e) else 'parse error'})") from None
    if not isinstance(doc, dict):
        raise ValueError("the definition is not a YAML mapping")
    out = []
    for key, kind in (("measures", "measure"), ("dimensions", "dimension")):
        for m in doc.get(key) or []:
            name = _text(m.get("name")) if isinstance(m, dict) else ""
            if name:
                out.append({"kind": kind, "name": name, "label": _text(m.get("display_name")) or name,
                            "comment": _text(m.get("comment")), "synonyms": _strings(m.get("synonyms"))})
    if not out:
        raise ValueError("the definition has no measures or dimensions")
    return out


def _metric_specs(view, entries):
    short = view.split(".")[-1]
    return [{"ref": f"{view}#{m['name']}", "kind": m["kind"], "name": m["label"], "alt": f"{m['label']} ({short})",
             "definition": m["comment"], "synonyms": m["synonyms"], "domain": None, "status": "draft", "tags": [view],
             "links": [(view, m["name"], "measures" if m["kind"] == "measure" else "describes")]} for m in entries]


# ---------- storing ----------

def _baselines(store):
    """What the source said at the last import, by source_ref: the fields to tell a user's edit from a source change."""
    store.conn.execute("CREATE TABLE IF NOT EXISTS ontology_baseline (source_ref TEXT PRIMARY KEY, fields TEXT NOT NULL)")
    return {r["source_ref"]: json.loads(r["fields"]) for r in store.conn.execute("SELECT * FROM ontology_baseline")}


def _save_baseline(store, ref, fields):
    with store.conn:
        store.conn.execute("INSERT OR REPLACE INTO ontology_baseline (source_ref, fields) VALUES (?, ?)",
                           (ref, json.dumps(fields)))


def _source_values(spec):
    """The spec's fields as a Concept would store them, so they compare equal to what is stored."""
    probe = Concept(name=spec["name"], definition=spec["definition"], synonyms=spec["synonyms"], domain=spec["domain"],
                    status=spec["status"])
    return {f: getattr(probe, f) for f in FIELDS}


def _merge(current, source, base):
    """(changed fields, fields kept because the user edited them) for a concept that already exists.

    A field the source changed since the last import is replaced unless the user changed it too. With no record of the
    last import, only blank fields are filled.
    """
    changed, kept = {}, []
    for f in FIELDS:
        have, new = getattr(current, f), source[f]
        if base is None:
            if have in _BLANK and new not in _BLANK:
                changed[f] = new
        elif new != base.get(f):
            if have == base.get(f):
                if new != have:
                    changed[f] = new
            else:
                kept.append(f)
    return changed, kept


def _entry(concept, spec, added, removed, total, **more):
    return {"id": concept.id, "name": concept.name, "kind": spec["kind"], "links_added": added,
            "links_removed": removed, "links": total, **more}


def _sync_links(store, concept, spec, now):
    """Make the concept's ontology links match the spec. Returns (added, removed, total)."""
    have = {(e.target.table, e.target.column): e for e in store.concept_links(concept.id)}
    new = []
    for table, column, relation in spec["links"]:
        try:
            target = Endpoint(table=table, column=column)
        except ValidationError:
            continue
        old = have.get((table, column))
        if old is not None and not (old.provenance.origin == "ontology" and old.relation != relation):
            continue  # already linked: by this import, or by a person, whose link is left alone
        new.append(rel.Edge(kind="concept_link", source=Endpoint(table=f"concept:{concept.id}"), target=target,
                            directed=True, provenance=Provenance(origin="ontology", source_ref=spec["ref"], fetched_at=now),
                            status="accepted", relation=relation))
    wanted = {(t, c) for t, c, _ in spec["links"]}
    stale = [e.id for k, e in have.items() if e.provenance.origin == "ontology"
             and e.provenance.source_ref == spec["ref"] and k not in wanted]
    store.upsert_edges(new)
    store.delete_edges(stale)
    replaced = sum(1 for e in new if (e.target.table, e.target.column) in have)
    return len(new) - replaced, len(stale), len(have) - len(stale) + len(new) - replaced


def _sync(store, specs, now, report):
    """Create or update one concept per spec and bring its links in line. Fills the report; returns the refs seen."""
    existing = {c.provenance.source_ref: c for c in store.concepts() if c.provenance.origin == "ontology"}
    baselines = _baselines(store)
    taken = {c.name.casefold() for c in store.concepts()}
    seen = set()
    for spec in specs:
        ref = spec["ref"]
        if ref in seen:
            report["skipped"].append({"name": spec["name"], "reason": f"{ref} appears twice in the source"})
            continue
        seen.add(ref)
        source = _source_values(spec)
        concept = existing.get(ref)
        if concept is None:
            name = next((n for n in (spec["name"], spec["alt"]) if n.casefold() not in taken), None)
            if name is None:
                report["skipped"].append({"name": spec["name"], "reason": "a concept with this name already exists"})
                continue
            taken.add(name.casefold())
            concept = store.save_concept(Concept(
                name=name, definition=source["definition"], synonyms=source["synonyms"], domain=source["domain"],
                status=source["status"], tags=spec["tags"],
                provenance=ConceptProvenance(origin="ontology", source_ref=ref, fetched_at=now)))[0]
            added, removed, total = _sync_links(store, concept, spec, now)
            report["created"].append(_entry(concept, spec, added, removed, total))
        else:
            changed, kept = _merge(concept, source, baselines.get(ref))
            if "name" in changed and changed["name"].casefold() in taken - {concept.name.casefold()}:
                report["skipped"].append({"name": concept.name, "reason": f"the source renamed it to \"{changed['name']}\", "
                                          "which another concept already has, so the name stays"})
                del changed["name"]
            if changed.get("name"):
                taken.discard(concept.name.casefold())
                taken.add(changed["name"].casefold())
            update = {**changed, "provenance": concept.provenance.model_copy(update={"fetched_at": now})}
            if changed:
                update["updated_at"] = now
            concept = store.save_concept(concept.model_copy(update=update))[0]
            added, removed, total = _sync_links(store, concept, spec, now)
            if changed or added or removed:
                report["updated"].append(_entry(concept, spec, added, removed, total, fields=sorted(changed), kept=kept))
            else:
                report["unchanged"] += 1
        _save_baseline(store, ref, source)
    return seen, existing


def _drop_stale(store, existing, seen, source_of, report):
    """Remove the ontology links of concepts whose source no longer lists them. The concepts themselves stay."""
    for ref, concept in existing.items():
        if ref in seen or not source_of(ref):
            continue
        removed = [e.id for e in store.concept_links(concept.id)
                   if e.provenance.origin == "ontology" and e.provenance.source_ref == ref]
        store.delete_edges(removed)
        report["stale"].append({"id": concept.id, "name": concept.name, "links_removed": len(removed)})


# ---------- the run ----------

def run(ex, store):
    """Read domains, pages and metric views and bring the `ontology` concepts in line. Read-only toward Databricks.

    Each source can fail on its own (a 403 or 404 on a Beta endpoint is "not available on this workspace") and the
    others still run. The last source, certification, rewrites the local certification cache and touches no concept.
    Returns {"sources": {id: {"status": ok|unavailable|failed, ...}}, "created", "updated", "skipped",
    "unchanged", "stale", "unreadable"}.
    """
    now = dbx.now()
    report = {"sources": {}, "created": [], "updated": [], "skipped": [], "unchanged": 0, "stale": [], "unreadable": []}
    sources = report["sources"]
    labels = {}
    try:
        domains = _fetch_all(ex, DOMAINS_PATH, "domains")
        labels = _domain_labels(domains)
        sources["domains"] = {"status": "ok", "count": len(domains)}
    except Exception as e:
        sources["domains"] = _failure(e)

    page_specs, pages_ok = [], False
    try:
        pages = _fetch_all(ex, PAGES_PATH, "pages", "knowledge_pages")
        pages_ok = True
        for p in pages:
            spec, reason = _page_spec(p, labels)
            if spec:
                page_specs.append(spec)
            else:
                report["skipped"].append({"name": _text(_get(p, "display_name", "displayName")) or _text(_get(p, "name")) or "(page)",
                                          "reason": reason})
        sources["pages"] = {"status": "ok", "count": len(pages)}
    except Exception as e:
        sources["pages"] = _failure(e)

    metric_specs, views_ok, unreadable = [], False, set()
    try:
        views = [".".join(str(x) for x in (r.get("table_catalog"), r.get("table_schema"), r.get("table_name")))
                 for r in concepts._rows(ex.query(METRIC_VIEWS_SQL, None, VIEW_CAP))]
        views_ok = True
        for view in views:
            try:
                metric_specs += _metric_specs(view, parse_metric_view(_definition(ex, view)))
            except Exception as e:
                reason = str(e) if isinstance(e, ValueError) else dbx.clean_error(e)
                unreadable.add(view)
                report["unreadable"].append({"view": view, "reason": reason})
        sources["metric_views"] = {"status": "ok", "count": len(views), "unreadable": len(unreadable)}
    except Exception as e:
        sources["metric_views"] = _failure(e)

    try:  # the badges read this cache; a failure here (no warehouse, no access) leaves the old cache as it was
        cert = refresh_certification(ex)
        sources["certification"] = {"status": "ok", "count": len(cert["tables"]) + len(cert["columns"])}
    except Exception as e:
        sources["certification"] = _failure(e)

    seen, existing = _sync(store, page_specs + metric_specs, now, report)
    view_of = lambda ref: ref.rsplit("#", 1)[0] if "#" in ref else None  # noqa: E731
    _drop_stale(store, existing, seen,
                lambda ref: (views_ok and view_of(ref) not in unreadable) if view_of(ref) else pages_ok, report)
    return report


def _definition(ex, view):
    text = dbx.table_definition(ex, view)
    if not text:
        raise ValueError("the tables API returned no view definition")
    return text


# ---------- certification ----------

class NeedsWarehouse(ValueError):
    """Raised when something needs a SQL warehouse and none is selected."""


def certification(ex):
    """Runs the one warehouse query for the `system.certification_status` tag: {"tables": {name: status}, "columns":
    {"table#column": status}, "ignored", "truncated"}. Status is `certified` or `deprecated`; any other value is ignored
    and counted. Writes nothing: see refresh_certification."""
    result = ex.query(CERT_SQL, None, CERT_ROW_CAP)
    tables, columns, ignored = {}, {}, 0
    for r in concepts._rows(result):
        status = (r.get("tag_value") or "").strip().lower()
        if status not in CERT_VALUES:
            ignored += 1
            continue
        table = f"{r['catalog_name']}.{r['schema_name']}.{r['table_name']}"
        if r.get("scope") == "column" and r.get("column_name"):
            columns[f"{table}#{r['column_name']}"] = status
        else:
            tables[table] = status
    return {"tables": tables, "columns": columns, "ignored": ignored, "truncated": bool(result.get("truncated"))}


def cached_certification(ex):
    """The certification cache as the API returns it. Never queries; empty maps and a null `fetched_at` when nothing is cached."""
    try:
        payload = json.loads((Path(ex.root) / CERT_CACHE).read_text(encoding="utf-8"))
        data = payload["data"]
        return {"tables": dict(data["tables"]), "columns": dict(data["columns"]), "ignored": int(data["ignored"]),
                "truncated": bool(data["truncated"]), "fetched_at": payload["fetched_at"]}
    except (OSError, ValueError, KeyError, TypeError):  # absent or unreadable: as if never fetched
        return {"tables": {}, "columns": {}, "ignored": 0, "truncated": False, "fetched_at": None}


def refresh_certification(ex):
    """Runs the one tag query, writes the cache (the {"fetched_at", "data"} file shape of the other cached metadata) and
    returns it. Raises NeedsWarehouse without a selected warehouse. A failed query leaves the old cache in place."""
    if not ex.warehouse_id:
        raise NeedsWarehouse("Select a SQL warehouse first: the certification tag is read with one query on it.")
    data = certification(ex)
    fetched_at = dbx.now()
    path = Path(ex.root) / CERT_CACHE
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"fetched_at": fetched_at, "data": data}, indent=2), encoding="utf-8")
    return {**data, "fetched_at": fetched_at}
