"""Relationship store: one model for every edge between tables or columns, with provenance, in SQLite.

Derived kinds (fk, lineage, view_dep) are never stored. They are normalized from Explorer.relations()
at read time with status "derived". Every other kind is persisted in data/relationships/<profile>.sqlite.
A user note on a derived edge is kept in an overlay keyed by the edge's natural key.

Natural key: (kind, source table, source column, target table, target column). Writes upsert on it,
so re-importing the same edge never duplicates it. Undirected edges are stored with their endpoints
in sorted order, so (a, b) and (b, a) are the same edge.
"""
import json
import re
import sqlite3
import uuid
from itertools import zip_longest
from pathlib import Path
from typing import Annotated, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, ValidationError, field_validator, model_validator
from pydantic_core import PydanticCustomError

from . import dbx

DERIVED_KINDS = ("fk", "lineage", "view_dep")
STORED_KINDS = ("join_mined", "manual", "sketch", "concept_link", "ontology")
STORED_STATUSES = ("proposed", "accepted", "rejected")
EXPORT_VERSION = 1
CONCEPT_STATUSES = ("draft", "reviewed", "certified")
CONCEPT_ORIGINS = ("manual", "uc_tag", "ontology")
# What a concept link can say, by what it points at.
TABLE_RELATIONS = ("defines", "measures", "identifies", "describes")
CONCEPT_RELATIONS = ("is_a", "part_of", "related_to")

Kind = Literal["fk", "lineage", "view_dep", "join_mined", "manual", "sketch", "concept_link", "ontology"]
Status = Literal["derived", "proposed", "accepted", "rejected"]

_TABLE = re.compile(r"^[^.\s]+\.[^.\s]+\.[^.\s]+$")
_PLACEHOLDER = "ph:"
_CONCEPT = "concept:"


class RelationshipInvalid(ValueError):
    """Validation failed. str(e) is '<path>: <reason>' (routes return it as HTTP 400)."""


class RelationshipNotFound(LookupError):
    """No relationship with that id (routes return HTTP 404)."""


# ---------- models ----------

def new_id():
    """A fresh id for a stored edge."""
    return "e_" + uuid.uuid4().hex


class Endpoint(BaseModel):
    """One end of an edge: a table (3-part name, ph:<uuid> placeholder or concept:<uuid>) and optionally a column."""
    model_config = ConfigDict(extra="forbid")
    table: str
    column: Optional[str] = None

    @field_validator("table")
    @classmethod
    def _table_name(cls, v):
        if v.startswith(_PLACEHOLDER):
            try:
                return _PLACEHOLDER + str(uuid.UUID(v[len(_PLACEHOLDER):]))
            except ValueError:
                raise PydanticCustomError("bad_table", 'a placeholder must be "ph:<uuid>"') from None
        if v.startswith(_CONCEPT):
            try:
                return _CONCEPT + str(uuid.UUID(v[len(_CONCEPT):]))
            except ValueError:
                raise PydanticCustomError("bad_table", 'a concept must be "concept:<uuid>"') from None
        if not _TABLE.match(v):
            raise PydanticCustomError("bad_table", 'a table must be "catalog.schema.table" or "ph:<uuid>"')
        return v

    @model_validator(mode="after")
    def _concept_has_no_column(self):
        if self.table.startswith(_CONCEPT) and self.column is not None:
            raise PydanticCustomError("bad_column", "a concept has no columns")
        return self

    @field_validator("column")
    @classmethod
    def _column_name(cls, v):
        if v is not None and not v.strip():
            raise PydanticCustomError("bad_column", "a column must not be empty (omit it for a table-level end)")
        return v


class Provenance(BaseModel):
    """Where an edge came from: an origin label, an optional reference into it, and when it was read."""
    model_config = ConfigDict(extra="forbid")
    origin: Annotated[str, Field(min_length=1)]
    source_ref: Optional[str] = None
    fetched_at: Optional[str] = None


MAX_TOGETHER = 5  # composite keys kept per edge


class Together(BaseModel):
    """Column pairs (source column, target column) that were joined in one condition, and how many runs had them so."""
    model_config = ConfigDict(extra="forbid")
    columns: list[tuple[str, str]]
    runs: Annotated[StrictInt, Field(ge=0)]


class Evidence(BaseModel):
    """How often an edge was observed, for kinds that are mined from activity."""
    model_config = ConfigDict(extra="forbid")
    runs: Optional[Annotated[StrictInt, Field(ge=0)]] = None
    users: Optional[Annotated[StrictInt, Field(ge=0)]] = None
    first_seen: Optional[str] = None
    last_seen: Optional[str] = None
    sample_refs: list[str] = Field(default_factory=list)
    together: list[Together] = Field(default_factory=list)  # composite keys this pair is part of


class Edge(BaseModel):
    """One relationship between two endpoints. The shape the API returns and the export file holds."""
    model_config = ConfigDict(extra="forbid")
    id: Annotated[str, Field(min_length=1)] = Field(default_factory=new_id)
    kind: Kind
    source: Endpoint
    target: Endpoint
    directed: StrictBool = True
    provenance: Provenance
    evidence: Optional[Evidence] = None
    status: Status = "proposed"
    note: str = ""
    relation: Optional[str] = None  # concept_link only: defines, measures, identifies, describes, is_a, part_of, related_to
    created_at: str = Field(default_factory=dbx.now)
    updated_at: str = Field(default_factory=dbx.now)


class ConceptProvenance(Provenance):
    """Where a concept came from: manual, a Unity Catalog tag (uc_tag) or an ontology import."""
    origin: Literal["manual", "uc_tag", "ontology"] = "manual"


def new_concept_id():
    """A fresh concept id (a bare uuid)."""
    return str(uuid.uuid4())


def _clean_list(v):
    """Strip each string, drop empties and case-insensitive repeats, keep order."""
    out, seen = [], set()
    for item in v:
        item = item.strip()
        if item and item.casefold() not in seen:
            seen.add(item.casefold())
            out.append(item)
    return out


class Concept(BaseModel):
    """A business term: name, definition, synonyms, domain and review status. Links to tables live in edges."""
    model_config = ConfigDict(extra="forbid")
    id: str = Field(default_factory=new_concept_id)
    name: Annotated[str, Field(min_length=1, max_length=200)]
    definition: str = ""
    synonyms: list[str] = Field(default_factory=list)
    domain: Optional[str] = None
    status: Literal["draft", "reviewed", "certified"] = "draft"
    tags: list[str] = Field(default_factory=list)
    provenance: ConceptProvenance = Field(default_factory=lambda: ConceptProvenance(fetched_at=dbx.now()))
    created_at: str = Field(default_factory=dbx.now)
    updated_at: str = Field(default_factory=dbx.now)

    @field_validator("id")
    @classmethod
    def _id(cls, v):
        try:
            return str(uuid.UUID(v))
        except ValueError:
            raise PydanticCustomError("bad_id", "a concept id must be a uuid") from None

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, v):
        return v.strip() if isinstance(v, str) else v

    @field_validator("synonyms", "tags")
    @classmethod
    def _lists(cls, v):
        return _clean_list(v)

    @field_validator("domain")
    @classmethod
    def _domain(cls, v):
        v = v.strip() if v is not None else None
        return v or None


class ColumnPair(BaseModel):
    """One column-level member of a rolled-up table edge. A side is None when that end names no column."""
    source: Optional[str] = None
    target: Optional[str] = None


class Rolled(Edge):
    """A table-level edge rolled up from its members (column edges, or the edge itself)."""
    columns: list[ColumnPair] = Field(default_factory=list)
    members: list[str] = Field(default_factory=list)


class EdgeCreate(BaseModel):
    """Body of POST /api/relationships: a user-drawn edge."""
    model_config = ConfigDict(extra="forbid")
    source: Endpoint
    target: Endpoint
    directed: StrictBool = True
    note: str = ""


class EdgePatch(BaseModel):
    """Body of PATCH /api/relationships/<id>: a status and/or a note."""
    model_config = ConfigDict(extra="forbid")
    status: Optional[Literal["derived", "proposed", "accepted", "rejected"]] = None
    note: Optional[str] = None


class BulkStatus(BaseModel):
    """Body of POST /api/relationships/bulk: one status for several stored edges."""
    model_config = ConfigDict(extra="forbid")
    ids: Annotated[list[Annotated[str, Field(min_length=1)]], Field(min_length=1, max_length=1000)]
    status: Literal["proposed", "accepted", "rejected"]


class Overlay(BaseModel):
    """A note on a derived edge, in the export file."""
    model_config = ConfigDict(extra="forbid")
    kind: Literal["fk", "lineage", "view_dep"]
    source: Endpoint
    target: Endpoint
    note: Annotated[str, Field(min_length=1)]
    updated_at: str = Field(default_factory=dbx.now)


class ExportFile(BaseModel):
    """The export/import format: stored edges plus notes on derived edges."""
    model_config = ConfigDict(extra="forbid")
    version: Annotated[StrictInt, Field(ge=EXPORT_VERSION, le=EXPORT_VERSION)]
    exported_at: Optional[str] = None
    edges: list[Edge]
    overlays: list[Overlay] = Field(default_factory=list)
    concepts: list[Concept] = Field(default_factory=list)


def _path(loc):
    out = ""
    for part in loc:
        out += f"[{part}]" if isinstance(part, int) else (f".{part}" if out else str(part))
    return out or "(root)"


def _parse(model, data):
    """Validate data against a model. Raises RelationshipInvalid with a path-prefixed message."""
    if not isinstance(data, dict):
        raise RelationshipInvalid("(root): body must be a JSON object")
    try:
        return model.model_validate(data)
    except ValidationError as e:
        first = e.errors()[0]
        raise RelationshipInvalid(f"{_path(first['loc'])}: {first['msg']}") from e


def parse_create(data) -> EdgeCreate:
    """Validate a POST body."""
    edge = _parse(EdgeCreate, data)
    for side in ("source", "target"):
        if getattr(edge, side).table.startswith(_CONCEPT):
            raise RelationshipInvalid(f"{side}.table: a concept is linked through /api/concepts, not drawn as an edge")
    _check_endpoints(edge.source, edge.target, "target")
    return edge


def parse_patch(data) -> EdgePatch:
    """Validate a PATCH body: at least one of status and note."""
    patch = _parse(EdgePatch, data)
    if patch.status is None and patch.note is None:
        raise RelationshipInvalid("(root): give a status, a note, or both")
    return patch


def parse_bulk(data) -> BulkStatus:
    """Validate a bulk status body. Derived ids are refused: only stored edges have a status."""
    body = _parse(BulkStatus, data)
    for i, rid in enumerate(body.ids):
        if not rid.startswith("e_"):
            raise RelationshipInvalid(f"ids[{i}]: only stored edges (e_...) have a status")
    return body


def check_statuses(statuses):
    """Validate the status filter of the suggestions list. Returns it as a tuple."""
    bad = [s for s in statuses if s not in STORED_STATUSES]
    if bad or not statuses:
        raise RelationshipInvalid(f"status: must be some of {', '.join(STORED_STATUSES)}")
    return tuple(statuses)


def parse_export(data) -> ExportFile:
    """Validate an export file, including that every edge is of a stored kind."""
    file = _parse(ExportFile, data)
    for what, values in (("id", [c.id for c in file.concepts]), ("name", [c.name.casefold() for c in file.concepts])):
        if len(set(values)) != len(values):
            raise RelationshipInvalid(f"concepts: two concepts share a {what}")
    for i, e in enumerate(file.edges):
        check_storable(e, f"edges[{i}]")
        _check_endpoints(e.source, e.target, f"edges[{i}].target")
    for i, o in enumerate(file.overlays):
        _check_endpoints(o.source, o.target, f"overlays[{i}].target")
    return file


def _check_endpoints(source, target, path):
    if (source.table, source.column) == (target.table, target.column):
        raise RelationshipInvalid(f"{path}: an edge cannot connect an endpoint to itself")


def check_storable(edge, path="(edge)"):
    """Derived kinds and the derived status are never stored. A concept link must be a well-formed one."""
    if edge.kind in DERIVED_KINDS:
        raise RelationshipInvalid(f'{path}.kind: "{edge.kind}" is derived from Unity Catalog and never stored')
    if edge.status not in STORED_STATUSES:
        raise RelationshipInvalid(f'{path}.status: "{edge.status}" is not a stored status (use proposed, accepted or rejected)')
    ends = (edge.source.table.startswith(_CONCEPT), edge.target.table.startswith(_CONCEPT))
    if edge.kind != "concept_link":
        if any(ends):
            raise RelationshipInvalid(f"{path}.source: only a concept_link edge can touch a concept")
        if edge.relation is not None:
            raise RelationshipInvalid(f"{path}.relation: only a concept_link edge has a relation")
        return
    if not ends[0]:
        raise RelationshipInvalid(f"{path}.source: a concept link starts at a concept (concept:<uuid>)")
    if edge.target.table.startswith(_PLACEHOLDER):
        raise RelationshipInvalid(f"{path}.target: a concept links to a table, a column or a concept")
    allowed = CONCEPT_RELATIONS if ends[1] else TABLE_RELATIONS
    if edge.relation not in allowed:
        raise RelationshipInvalid(f"{path}.relation: a link to {'a concept' if ends[1] else 'a table or column'} "
                                  f"is one of {', '.join(allowed)}")


# ---------- natural keys and ids ----------

def _end(e):
    return (e.table, e.column or "")


def key_of(kind, source, target, directed=True):
    """The natural key (kind, source table, source column, target table, target column); '' for no column."""
    a, b = _end(source), _end(target)
    if not directed and b < a:
        a, b = b, a
    return (kind, *a, *b)


def derived_id(kind, source, target):
    """The id of a derived edge: kind:table[#column]->table[#column]. Doubles as its overlay key."""
    def end(e):
        return e.table + (f"#{e.column}" if e.column else "")
    return f"{kind}:{end(source)}->{end(target)}"


def parse_derived_id(rid):
    """Inverse of derived_id() for the derived kinds. Returns (kind, source, target) or None."""
    kind, sep, rest = rid.partition(":")
    if not sep or kind not in DERIVED_KINDS:
        return None
    head, arrow, tail = rest.partition("->")
    if not arrow:
        return None
    ends = []
    for part in (head, tail):
        table, _, column = part.partition("#")
        try:
            ends.append(Endpoint(table=table, column=column or None))
        except ValidationError:
            return None
    return kind, ends[0], ends[1]


# ---------- derived edges ----------

def derive_edges(relations, times=None):
    """Normalize an Explorer.relations() response into Edge objects with status 'derived'.

    FK edges become one column-level edge per column pair (table-level when the columns are unknown).
    A lineage edge seen in both directions becomes two directed edges, one per direction.
    `times` maps "object" and "lineage" to the fetch time of the cached data behind them.
    """
    times = times or {}
    out = []

    def add(kind, source, target, prov, evidence=None):
        stamp = prov.fetched_at or dbx.now()
        out.append(Edge(id=derived_id(kind, source, target), kind=kind, source=source, target=target,
                        provenance=prov, evidence=evidence, status="derived", created_at=stamp, updated_at=stamp))

    for e in relations.get("edges", []):
        s, t = e["source"], e["target"]
        if e["kind"] == "fk":
            prov = Provenance(origin="unity_catalog:table_constraints", source_ref=e.get("constraint"),
                              fetched_at=times.get("object"))
            pairs = [(c, p) for c, p in zip_longest(e.get("child_columns") or [], e.get("parent_columns") or [])
                     if c and p]
            for c, p in pairs or [(None, None)]:
                add("fk", Endpoint(table=s, column=c), Endpoint(table=t, column=p), prov)
        elif e["kind"] == "view_dep":
            add("view_dep", Endpoint(table=s), Endpoint(table=t),
                Provenance(origin="unity_catalog:view_dependencies", fetched_at=times.get("object")))
        elif e["kind"] == "lineage":
            seen = e.get("last_seen_by_dir") or {f"{s}->{t}": e.get("last_seen")}
            prov = Provenance(origin="unity_catalog:table_lineage", fetched_at=times.get("lineage"))
            for direction, ts in seen.items():
                a, _, b = direction.partition("->")
                add("lineage", Endpoint(table=a), Endpoint(table=b), prov, Evidence(last_seen=ts))
    return out


def derive_column_lineage(rows, fetched_at=None):
    """Column-level lineage edges from system.access.column_lineage rows, with status 'derived'.

    Each row has source_table_full_name, source_column_name, target_table_full_name, target_column_name and
    last_seen. A row that does not name two valid columns (a path-based source, a self loop) is skipped.
    """
    prov = Provenance(origin="unity_catalog:column_lineage", fetched_at=fetched_at)
    stamp = fetched_at or dbx.now()
    out, seen = [], set()
    for r in rows:
        try:
            source = Endpoint(table=r["source_table_full_name"], column=r["source_column_name"])
            target = Endpoint(table=r["target_table_full_name"], column=r["target_column_name"])
            _check_endpoints(source, target, "target")
        except (ValidationError, RelationshipInvalid, KeyError, TypeError):
            continue
        rid = derived_id("lineage", source, target)
        if rid in seen:
            continue
        seen.add(rid)
        out.append(Edge(id=rid, kind="lineage", source=source, target=target, provenance=prov,
                        evidence=Evidence(last_seen=r.get("last_seen")), status="derived",
                        created_at=stamp, updated_at=stamp))
    return out


# ---------- rollup ----------

_PRIORITY = ("accepted", "proposed", "derived", "rejected")


def _merge_evidence(items):
    items = [i for i in items if i]
    if not items:
        return None
    seen = [x for i in items for x in (i.first_seen, i.last_seen) if x]
    refs = list(dict.fromkeys(r for i in items for r in i.sample_refs))[:10]
    runs = [i.runs for i in items if i.runs is not None]
    users = [i.users for i in items if i.users is not None]
    return Evidence(runs=sum(runs) if runs else None, users=max(users) if users else None,
                    first_seen=min(seen) if seen else None, last_seen=max(seen) if seen else None, sample_refs=refs)


def _add_evidence(old, new):
    """Evidence of the same edge from two mining runs: runs added, users the larger, newest sample refs first (5)."""
    both = _merge_evidence([old, new])
    both.sample_refs = list(dict.fromkeys([*new.sample_refs, *old.sample_refs]))[:5]
    runs = {}
    for t in [*old.together, *new.together]:
        key = tuple(t.columns)
        runs[key] = runs.get(key, 0) + t.runs
    both.together = [Together(columns=list(k), runs=n)
                     for k, n in sorted(runs.items(), key=lambda kv: (-kv[1], kv[0]))[:MAX_TOGETHER]]
    return both


def rollup(edges, notes=None):
    """The table-level view: one Rolled edge per (kind, source table, target table), built from its members.

    A column edge implies its table edge. `columns` lists the column pairs of the members, `members` their ids.
    A group of one table-level edge keeps that edge's id. Any other group gets the table-level derived id.
    The status is the strongest member's (accepted, proposed, derived, rejected). `notes` maps natural keys to
    overlay notes and wins for derived edges.
    """
    notes = notes or {}
    groups = {}
    for e in edges:
        pair = (e.source.table, e.target.table)
        key = (e.kind, *(pair if e.directed else tuple(sorted(pair))), e.directed)
        groups.setdefault(key, []).append(e)
    out = []
    for (kind, a, b, directed), members in groups.items():
        first = members[0]
        src, tgt = Endpoint(table=a), Endpoint(table=b)
        pairs = []
        for m in members:
            sc, tc = (m.target.column, m.source.column) if (m.source.table != a) else (m.source.column, m.target.column)
            if (sc or tc) and ColumnPair(source=sc, target=tc) not in pairs:
                pairs.append(ColumnPair(source=sc, target=tc))
        single = len(members) == 1 and not (first.source.column or first.target.column)
        rid = first.id if single else derived_id(kind, src, tgt)
        note = notes.get(key_of(kind, src, tgt, directed)) or next((m.note for m in members if m.note), "")
        status = next(s for s in _PRIORITY if any(m.status == s for m in members))
        out.append(Rolled(
            id=rid, kind=kind, source=src, target=tgt, directed=directed,
            provenance=first.provenance,
            evidence=_merge_evidence([m.evidence for m in members]), status=status, note=note,
            created_at=min(m.created_at for m in members), updated_at=max(m.updated_at for m in members),
            columns=pairs, members=[m.id for m in members]))
    return out


# ---------- the SQLite store ----------

_V1 = """
CREATE TABLE edge (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    src_table TEXT NOT NULL,
    src_column TEXT NOT NULL DEFAULT '',
    tgt_table TEXT NOT NULL,
    tgt_column TEXT NOT NULL DEFAULT '',
    directed INTEGER NOT NULL,
    provenance TEXT NOT NULL,
    evidence TEXT,
    status TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (kind, src_table, src_column, tgt_table, tgt_column)
);
CREATE INDEX edge_src_table ON edge (src_table);
CREATE INDEX edge_tgt_table ON edge (tgt_table);
CREATE TABLE derived_note (
    kind TEXT NOT NULL,
    src_table TEXT NOT NULL,
    src_column TEXT NOT NULL DEFAULT '',
    tgt_table TEXT NOT NULL,
    tgt_column TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (kind, src_table, src_column, tgt_table, tgt_column)
);
"""

# Concepts, and the relation a concept link carries. concept.name_key is the case-folded name: unique per database,
# and there is one database per profile.
_V2 = """
CREATE TABLE concept (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    definition TEXT NOT NULL DEFAULT '',
    synonyms TEXT NOT NULL DEFAULT '[]',
    domain TEXT,
    status TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    provenance TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
ALTER TABLE edge ADD COLUMN relation TEXT;
"""

# MIGRATIONS[i] takes the database from user_version i to i + 1. Append; never edit a shipped entry.
MIGRATIONS = [_V1, _V2]


def migrate(conn):
    """Bring the database up to the latest schema, tracked by PRAGMA user_version."""
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    if version > len(MIGRATIONS):
        raise RuntimeError(f"relationship database is schema version {version}; this app knows up to {len(MIGRATIONS)}")
    for i in range(version, len(MIGRATIONS)):
        conn.executescript(f"BEGIN;\n{MIGRATIONS[i]}\nPRAGMA user_version = {i + 1};\nCOMMIT;")


def db_path(profile):
    """data/relationships/<profile>.sqlite, under whatever dbx.DATA is when called."""
    return dbx.DATA / "relationships" / f"{dbx.safe(profile)}.sqlite"


def open_store(profile):
    """Open (and migrate) the store for one profile."""
    return Store(db_path(profile))


class Store:
    """The persisted (non-derived) edges and the notes on derived edges."""

    def __init__(self, path):
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(path))
        self.conn.row_factory = sqlite3.Row
        migrate(self.conn)

    def close(self):
        """Close the connection."""
        self.conn.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    # -- rows <-> edges --
    @staticmethod
    def _edge(row):
        return Edge(
            id=row["id"], kind=row["kind"],
            source=Endpoint(table=row["src_table"], column=row["src_column"] or None),
            target=Endpoint(table=row["tgt_table"], column=row["tgt_column"] or None),
            directed=bool(row["directed"]), provenance=json.loads(row["provenance"]),
            evidence=json.loads(row["evidence"]) if row["evidence"] else None,
            status=row["status"], note=row["note"], relation=row["relation"],
            created_at=row["created_at"], updated_at=row["updated_at"])

    def _by_key(self, key):
        return self.conn.execute(
            "SELECT * FROM edge WHERE kind=? AND src_table=? AND src_column=? AND tgt_table=? AND tgt_column=?",
            key).fetchone()

    def _upsert(self, edge):
        """Insert or update by natural key without committing. Returns (stored edge, created)."""
        key = key_of(edge.kind, edge.source, edge.target, edge.directed)
        prov = edge.provenance.model_dump_json()
        ev = edge.evidence.model_dump_json() if edge.evidence else None
        if edge.kind == "concept_link":
            self._require_concepts(edge)
        row = self._by_key(key)
        if row:
            self.conn.execute(
                "UPDATE edge SET directed=?, provenance=?, evidence=?, status=?, note=?, relation=?, updated_at=? "
                "WHERE id=?",
                (int(edge.directed), prov, ev, edge.status, edge.note, edge.relation, dbx.now(), row["id"]))
            return self.get(row["id"]), False
        rid = edge.id
        if self.conn.execute("SELECT 1 FROM edge WHERE id=?", (rid,)).fetchone():
            rid = new_id()  # the incoming id belongs to a different edge here
        self.conn.execute("INSERT INTO edge (id, kind, src_table, src_column, tgt_table, tgt_column, directed, provenance,"
                          " evidence, status, note, relation, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                          (rid, *key, int(edge.directed), prov, ev, edge.status, edge.note, edge.relation,
                           edge.created_at, edge.updated_at))
        return self.get(rid), True

    def _require_concepts(self, edge):
        """A concept link's concept ends must exist. RelationshipNotFound otherwise."""
        for side in ("source", "target"):
            table = getattr(edge, side).table
            if table.startswith(_CONCEPT) and not self.conn.execute(
                    "SELECT 1 FROM concept WHERE id=?", (table[len(_CONCEPT):],)).fetchone():
                raise RelationshipNotFound(f"concept not found: {table[len(_CONCEPT):]}")

    # -- stored edges --
    def get(self, rid):
        """The stored edge with this id; RelationshipNotFound if none."""
        row = self.conn.execute("SELECT * FROM edge WHERE id=?", (rid,)).fetchone()
        if not row:
            raise RelationshipNotFound(f"relationship not found: {rid}")
        return self._edge(row)

    def upsert(self, edge):
        """Insert or update by natural key. Returns (stored edge, created). Derived kinds are refused."""
        check_storable(edge)
        _check_endpoints(edge.source, edge.target, "target")
        with self.conn:
            return self._upsert(edge)

    def create_manual(self, body):
        """Add a user-drawn edge (accepted). Drawing an existing edge again re-accepts it. Returns (edge, created)."""
        provenance = Provenance(origin="user", fetched_at=dbx.now())
        edge = Edge(kind="manual", source=body.source, target=body.target, directed=body.directed,
                    provenance=provenance, status="accepted", note=body.note)
        with self.conn:
            row = self._by_key(key_of("manual", edge.source, edge.target, edge.directed))
            if row:
                note = body.note or row["note"]
                self.conn.execute("UPDATE edge SET status='accepted', note=?, updated_at=? WHERE id=?",
                                  (note, dbx.now(), row["id"]))
                return self.get(row["id"]), False
            return self._upsert(edge)

    def patch(self, rid, status=None, note=None):
        """Change a stored edge's status and/or note."""
        if status is not None and status not in STORED_STATUSES:
            raise RelationshipInvalid(f'status: "{status}" is not a stored status (use proposed, accepted or rejected)')
        self.get(rid)
        with self.conn:
            if status is not None:
                self.conn.execute("UPDATE edge SET status=?, updated_at=? WHERE id=?", (status, dbx.now(), rid))
            if note is not None:
                self.conn.execute("UPDATE edge SET note=?, updated_at=? WHERE id=?", (note, dbx.now(), rid))
        return self.get(rid)

    def delete(self, rid):
        """Remove a stored edge; RelationshipNotFound if none."""
        self.get(rid)
        with self.conn:
            self.conn.execute("DELETE FROM edge WHERE id=?", (rid,))

    def upsert_mined(self, edges, replace=False):
        """Store edges mined from activity in one transaction. Returns (created, updated).

        A new edge is stored as given (status proposed). An existing one keeps its status, note and id, so an
        accepted or rejected edge stays that way, and takes the new evidence: added to what it had, or in place of it
        when `replace` is set (a re-mine of the whole window). Added evidence sums runs, keeps the larger user count
        (users are only counted, never kept, so across runs the count is a lower bound), and spans first to last seen.
        """
        created = updated = 0
        with self.conn:
            for edge in edges:
                check_storable(edge)
                _check_endpoints(edge.source, edge.target, "target")
                row = self._by_key(key_of(edge.kind, edge.source, edge.target, edge.directed))
                if not row:
                    self._upsert(edge)
                    created += 1
                    continue
                old = self._edge(row)
                evidence = edge.evidence if replace or not old.evidence else _add_evidence(old.evidence, edge.evidence)
                self.conn.execute("UPDATE edge SET provenance=?, evidence=?, updated_at=? WHERE id=?",
                                  (edge.provenance.model_dump_json(), evidence.model_dump_json() if evidence else None,
                                   dbx.now(), row["id"]))
                updated += 1
        return created, updated

    def suggestions(self, statuses=("proposed",), kind="join_mined", table=None):
        """Stored edges of one kind with one of these statuses, most evidence first (runs, users, last seen)."""
        marks = ",".join("?" * len(statuses))
        sql = f"SELECT * FROM edge WHERE kind=? AND status IN ({marks})"
        args = [kind, *statuses]
        if table:
            sql += " AND (src_table=? OR tgt_table=?)"
            args += [table, table]
        edges = [self._edge(r) for r in self.conn.execute(sql, args)]
        edges.sort(key=lambda e: e.id)
        edges.sort(key=lambda e: (e.evidence.last_seen if e.evidence else None) or "", reverse=True)
        edges.sort(key=lambda e: ((e.evidence.runs or 0, e.evidence.users or 0) if e.evidence else (0, 0)), reverse=True)
        return edges

    def status_counts(self, kind="join_mined"):
        """How many stored edges of one kind have each status."""
        rows = self.conn.execute("SELECT status, COUNT(*) AS n FROM edge WHERE kind=? GROUP BY status", (kind,))
        return {s: 0 for s in STORED_STATUSES} | {r["status"]: r["n"] for r in rows}

    def set_status_many(self, ids, status):
        """Set one status on several stored edges, all or none. Returns how many. Unknown ids are RelationshipNotFound."""
        if status not in STORED_STATUSES:
            raise RelationshipInvalid(f'status: "{status}" is not a stored status (use proposed, accepted or rejected)')
        ids = list(dict.fromkeys(ids))
        with self.conn:
            for rid in ids:
                self.get(rid)
            self.conn.executemany("UPDATE edge SET status=?, updated_at=? WHERE id=?",
                                  [(status, dbx.now(), rid) for rid in ids])
        return len(ids)

    def all_edges(self):
        """Every stored edge, oldest first."""
        return [self._edge(r) for r in self.conn.execute("SELECT * FROM edge ORDER BY created_at, id")]

    def edges_for(self, table):
        """Stored edges with this table at either end. Concept links are not table relationships and are left out."""
        rows = self.conn.execute("SELECT * FROM edge WHERE (src_table=? OR tgt_table=?) AND kind<>'concept_link' "
                                 "ORDER BY created_at, id", (table, table))
        return [self._edge(r) for r in rows]

    def table_view(self, table=None):
        """Stored edges rolled up to table level, for one table or for all. Concept links are left out."""
        return rollup(self.edges_for(table) if table else [e for e in self.all_edges() if e.kind != "concept_link"])

    def upsert_edges(self, edges):
        """Upsert several edges in one transaction, all or none. Returns (created, updated)."""
        created = updated = 0
        for edge in edges:
            check_storable(edge)
            _check_endpoints(edge.source, edge.target, "target")
        with self.conn:
            for edge in edges:
                _, was_created = self._upsert(edge)
                created += was_created
                updated += not was_created
        return created, updated

    def delete_edges(self, ids):
        """Remove stored edges by id, ignoring unknown ids. Returns how many were removed."""
        with self.conn:
            return sum(self.conn.execute("DELETE FROM edge WHERE id=?", (rid,)).rowcount for rid in ids)

    # -- concepts --
    @staticmethod
    def _concept(row):
        return Concept(id=row["id"], name=row["name"], definition=row["definition"],
                       synonyms=json.loads(row["synonyms"]), domain=row["domain"], status=row["status"],
                       tags=json.loads(row["tags"]), provenance=json.loads(row["provenance"]),
                       created_at=row["created_at"], updated_at=row["updated_at"])

    def concepts(self):
        """Every concept, by name."""
        rows = self.conn.execute("SELECT * FROM concept ORDER BY name_key, id")
        return [self._concept(r) for r in rows]

    def concept(self, cid):
        """The concept with this id; RelationshipNotFound if none."""
        row = self.conn.execute("SELECT * FROM concept WHERE id=?", (cid,)).fetchone()
        if not row:
            raise RelationshipNotFound(f"concept not found: {cid}")
        return self._concept(row)

    def _upsert_concept(self, c):
        """Insert or update a concept by id without committing. Returns True when it was inserted."""
        key = c.name.casefold()
        clash = self.conn.execute("SELECT id FROM concept WHERE name_key=? AND id<>?", (key, c.id)).fetchone()
        if clash:
            raise RelationshipInvalid(f'name: a concept named "{c.name}" already exists')
        values = (c.name, key, c.definition, json.dumps(c.synonyms), c.domain, c.status, json.dumps(c.tags),
                  c.provenance.model_dump_json(), c.updated_at)
        if self.conn.execute("SELECT 1 FROM concept WHERE id=?", (c.id,)).fetchone():
            self.conn.execute("UPDATE concept SET name=?, name_key=?, definition=?, synonyms=?, domain=?, status=?, "
                              "tags=?, provenance=?, updated_at=? WHERE id=?", (*values, c.id))
            return False
        self.conn.execute("INSERT INTO concept (name, name_key, definition, synonyms, domain, status, tags, provenance,"
                          " updated_at, id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", (*values, c.id, c.created_at))
        return True

    def save_concept(self, concept):
        """Insert or update a concept by id. Returns (concept, created). A taken name is RelationshipInvalid."""
        with self.conn:
            created = self._upsert_concept(concept)
        return self.concept(concept.id), created

    def delete_concept(self, cid):
        """Remove a concept and every link that starts or ends at it. Returns how many links went."""
        self.concept(cid)
        end = _CONCEPT + cid
        with self.conn:
            gone = self.conn.execute("DELETE FROM edge WHERE kind='concept_link' AND (src_table=? OR tgt_table=?)",
                                     (end, end)).rowcount
            self.conn.execute("DELETE FROM concept WHERE id=?", (cid,))
        return gone

    def concept_links(self, cid, incoming=False):
        """Links that start at this concept, or (incoming) that point at it from another concept."""
        col = "tgt_table" if incoming else "src_table"
        rows = self.conn.execute(f"SELECT * FROM edge WHERE kind='concept_link' AND {col}=? ORDER BY created_at, rowid",
                                 (_CONCEPT + cid,))
        return [self._edge(r) for r in rows]

    def links_to_tables(self, tables):
        """Concept links whose target is one of these tables (a table or one of its columns)."""
        tables = list(dict.fromkeys(tables))
        if not tables:
            return []
        marks = ",".join("?" * len(tables))
        rows = self.conn.execute(f"SELECT * FROM edge WHERE kind='concept_link' AND tgt_table IN ({marks}) "
                                 "ORDER BY created_at, rowid", tables)
        return [self._edge(r) for r in rows]

    def link_counts(self):
        """Map of concept id to how many links start at it."""
        rows = self.conn.execute("SELECT src_table, COUNT(*) AS n FROM edge WHERE kind='concept_link' GROUP BY src_table")
        return {r["src_table"][len(_CONCEPT):]: r["n"] for r in rows}

    # -- notes on derived edges --
    def derived_notes(self):
        """Map of natural key to note for every derived edge that has one."""
        rows = self.conn.execute("SELECT * FROM derived_note")
        return {(r["kind"], r["src_table"], r["src_column"], r["tgt_table"], r["tgt_column"]): r["note"] for r in rows}

    def _set_note(self, key, note, stamp=None):
        if note:
            self.conn.execute("INSERT OR REPLACE INTO derived_note VALUES (?,?,?,?,?,?,?)",
                              (*key, note, stamp or dbx.now()))
        else:
            self.conn.execute("DELETE FROM derived_note WHERE kind=? AND src_table=? AND src_column=? "
                              "AND tgt_table=? AND tgt_column=?", key)

    def set_derived_note(self, rid, note):
        """Attach (or, when empty, clear) a note on the derived edge with this id. Returns it as an Edge."""
        parsed = parse_derived_id(rid)
        if not parsed:
            raise RelationshipNotFound(f"relationship not found: {rid}")
        kind, source, target = parsed
        with self.conn:
            self._set_note(key_of(kind, source, target), note)
        return Edge(id=rid, kind=kind, source=source, target=target, status="derived", note=note,
                    provenance=Provenance(origin="derived"))

    def clear_derived_note(self, rid):
        """Remove the note on a derived edge; RelationshipNotFound if it had none."""
        parsed = parse_derived_id(rid)
        key = key_of(*parsed) if parsed else None
        if not key or key not in self.derived_notes():
            raise RelationshipNotFound(f"relationship not found: {rid}")
        with self.conn:
            self._set_note(key, "")

    # -- export / import --
    def export(self, concepts_only=False):
        """Every stored edge, derived-edge note and concept, in the import format.

        With `concepts_only`, just the concepts and their links (no overlays, no other edges).
        """
        overlays = [Overlay(kind=k[0], source=Endpoint(table=k[1], column=k[2] or None),
                            target=Endpoint(table=k[3], column=k[4] or None), note=n)
                    for k, n in sorted(self.derived_notes().items())]
        edges = self.all_edges()
        if concepts_only:
            overlays, edges = [], [e for e in edges if e.kind == "concept_link"]
        file = ExportFile(version=EXPORT_VERSION, exported_at=dbx.now(), edges=edges, overlays=overlays,
                          concepts=self.concepts())
        return file.model_dump(mode="json")

    def import_file(self, file):
        """Upsert a parsed export file in one transaction (concepts first, then edges). Returns counts.

        A failure, such as a name another concept already has or a link to a concept that exists nowhere,
        leaves the store as it was.
        """
        created = updated = concepts_created = 0
        with self.conn:
            for c in file.concepts:
                concepts_created += self._upsert_concept(c)
            for e in file.edges:
                _, was_created = self._upsert(e)
                created += was_created
                updated += not was_created
            for o in file.overlays:
                self._set_note(key_of(o.kind, o.source, o.target), o.note, o.updated_at)
        return {"imported": len(file.edges), "created": created, "updated": updated, "overlays": len(file.overlays),
                "concepts": len(file.concepts), "concepts_created": concepts_created}


# ---------- the unified read ----------

def unified(store, table, relations=None, times=None, level="table", column_lineage=None):
    """Derived edges (from `relations`) plus stored edges for one table, with notes on derived ones applied.

    level "table" rolls column edges up to table edges; "column" returns each edge as it is, and adds the column
    lineage rows in `column_lineage` ({"fetched_at", "data": [rows]}, as Explorer.column_lineage returns it).
    Returns {"table", "level", "nodes", "edges", "errors"}; nodes and errors pass through from `relations`.
    """
    if level not in ("table", "column"):
        raise RelationshipInvalid('level: must be "table" or "column"')
    relations = relations or {"nodes": [], "edges": [], "errors": []}
    notes = store.derived_notes()
    derived = derive_edges(relations, times)
    if level == "column" and column_lineage:
        derived += derive_column_lineage(column_lineage.get("data") or [], column_lineage.get("fetched_at"))
    for e in derived:
        e.note = notes.get(key_of(e.kind, e.source, e.target), "")
    stored = store.edges_for(table)
    edges = derived + stored
    out = rollup(edges, notes) if level == "table" else edges
    nodes = list(relations.get("nodes", []))
    known = {n["id"] for n in nodes}
    if not any(n["id"] == table for n in nodes):
        nodes.insert(0, {"id": table, "label": table.split(".")[-1], "kind": "table", "focus": True})
        known.add(table)
    for e in [*stored, *(d for d in derived if d.provenance.origin.endswith(":column_lineage"))]:
        for end in (e.source, e.target):
            if end.table not in known:
                known.add(end.table)
                nodes.append({"id": end.table, "label": end.table.split(".")[-1],
                              "kind": "placeholder" if end.table.startswith(_PLACEHOLDER) else "table"})
    return {"table": table, "level": level, "nodes": nodes,
            "edges": [e.model_dump(mode="json") for e in out], "errors": relations.get("errors", [])}


def _oriented(table, source, target, pairs):
    """(other table, pairs read from `table`'s side) for an edge from `source` to `target`, or None when it has no
    end at `table`. `pairs` are (source column, target column)."""
    if source == table:
        return target, [(a, b) for a, b in pairs]
    if target == table:
        return source, [(b, a) for a, b in pairs]
    return None


def fk_join_keys(table, info):
    """Join keys from the foreign keys a table declares: [(other table, key)]. One key per constraint.

    `info` is the table's Unity Catalog metadata. Only constraints the table itself carries are visible, so a table
    that others point at gets those keys from the tables that declare them.
    """
    out = []
    for con in (info or {}).get("table_constraints") or []:
        fk = con.get("foreign_key_constraint")
        if not fk or not fk.get("parent_table") or dbx.is_internal(fk["parent_table"]):
            continue
        pairs = [(c, p) for c, p in zip_longest(fk.get("child_columns") or [], fk.get("parent_columns") or []) if c and p]
        if pairs:
            out.append((fk["parent_table"], {"pairs": [{"here": c, "there": p} for c, p in pairs], "source": "fk",
                                             "status": "derived", "runs": None, "name": fk.get("name")}))
    return out


def _combined_status(statuses):
    """One status for a key made of several stored edges: rejected if any is, accepted if all are, else proposed."""
    if "rejected" in statuses:
        return "rejected"
    return "accepted" if statuses and all(s == "accepted" for s in statuses) else "proposed"


def stored_join_keys(table, edges):
    """Join keys from stored edges: [(other table, key)], for `join_mined` and `manual` edges with `table` at an end.

    A mined column pair that was joined alone (or more often than the composite keys it is in account for) is a
    single-pair key with its runs, which count every statement that used the pair, composites included, as the
    suggestions list does. Each composite key recorded in `evidence.together` is one key with its own runs, and takes
    one status from its member edges. A manual edge is a key of one pair, or of none for a table-level edge.
    """
    singles, composites = [], {}
    for e in edges:
        if e.kind not in ("join_mined", "manual"):
            continue
        sc, tc = e.source.column, e.target.column
        if e.kind == "manual":
            hit = _oriented(table, e.source.table, e.target.table, [(sc, tc)] if sc and tc else [])
            if hit:
                singles.append((hit[0], {"pairs": [{"here": a, "there": b} for a, b in hit[1]], "source": "manual",
                                         "status": e.status, "runs": None, "name": None}))
            continue
        if not (sc and tc):
            continue
        together = e.evidence.together if e.evidence else []
        runs = (e.evidence.runs if e.evidence else None) or 0
        if not together or runs > sum(t.runs for t in together):
            hit = _oriented(table, e.source.table, e.target.table, [(sc, tc)])
            if hit:
                singles.append((hit[0], {"pairs": [{"here": a, "there": b} for a, b in hit[1]], "source": "mined",
                                         "status": e.status, "runs": runs, "name": None}))
        for t in together:
            cols = [tuple(c) for c in t.columns]
            if (sc, tc) not in cols:
                continue
            hit = _oriented(table, e.source.table, e.target.table, cols)
            if not hit:
                continue
            slot = composites.setdefault((hit[0], tuple(hit[1])), {"runs": 0, "statuses": []})
            slot["runs"] = max(slot["runs"], t.runs)
            slot["statuses"].append(e.status)
    out = list(singles)
    for (other, pairs), slot in composites.items():
        out.append((other, {"pairs": [{"here": a, "there": b} for a, b in pairs], "source": "mined",
                            "status": _combined_status(slot["statuses"]), "runs": slot["runs"], "name": None}))
    return out


def join_keys(store, table, info=None):
    """How `table` is known to join to other tables: foreign keys it declares, mined joins and manual edges.

    Returns {"table", "joins": [{"table": other, "keys": [{"pairs": [{"here", "there"}], "source": "fk" | "mined" |
    "manual", "status", "runs", "name"}]}]}. Columns are read from `table`'s side (`here`). Rejected keys are included
    and marked: the reader decides. Nothing is ranked, and no SQL text is involved.
    """
    found = fk_join_keys(table, info) + stored_join_keys(table, store.edges_for(table))
    by_other = {}
    for other, key in found:
        keys = by_other.setdefault(other, [])
        if key not in keys:
            keys.append(key)
    return {"table": table, "joins": [{"table": o, "keys": k} for o, k in sorted(by_other.items())]}


def check_table(table):
    """Validate a table name or placeholder from a query string. Returns it normalized."""
    if not table:
        raise RelationshipInvalid("table: required")
    if table.startswith(_CONCEPT):
        raise RelationshipInvalid("table: a concept is not a table")
    try:
        return Endpoint(table=table).table
    except ValidationError as e:
        raise RelationshipInvalid(f"table: {e.errors()[0]['msg']}") from e
