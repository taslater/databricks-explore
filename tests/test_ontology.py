"""Ontology import: plan, parsing, the sync rules (create, update, keep edits, stale links), certification and routes.

No Databricks access: a fake Explorer answers the REST calls, the tables API and the SQL from dictionaries.
"""
import json
import re

import pytest
from databricks.sdk import errors

import app as app_module
import concepts
import dbx
import ontology
import relationships as rel

VIEW = "main.sales.sales_metrics"
YAML = """
version: 1.1
source: main.sales.orders
dimensions:
  - name: order_month
    display_name: Order month
    expr: date_trunc('month', order_date)
    comment: Month the order was placed
    synonyms: [month]
  - name: region
    expr: region
measures:
  - name: total_revenue
    display_name: Total revenue
    expr: SUM(amount)
    comment: Sum of order amounts
    synonyms: [sales, turnover]
  - name: order_count
    expr: COUNT(1)
"""
DOMAINS = {"domains": [{"domain_id": "d1", "tag_key": "finance", "display_name": "Finance"},
                       {"domain_id": "d2", "tag_key": "ops"}]}
PAGE = {"name": "knowledge/pages/p1", "domain": "domains/d1", "display_name": "Churn", "description": "Customers leaving.",
        "body": "## Detail\nNo order in 90 days.", "synonyms": ["attrition"], "state": "PUBLISHED"}
PAGES = {"pages": [PAGE, {"name": "knowledge/pages/p2", "domain": "domains/d2", "display_name": "Backlog",
                          "description": "", "body": "", "synonyms": [], "state": "DRAFT"}]}


class FakeExplorer:
    """Answers GET paths from `rest`, the tables API from `defs` (YAML) and `kinds` (column -> dimension|measure), and the
    SQL from `views`, `cert` and `described` (view -> the DESCRIBE ... AS JSON document, or an Exception; absent fails)."""

    def __init__(self, rest=None, defs=None, views=(VIEW,), cert=(), warehouse_id="wh-1"):
        self.profile, self.warehouse_id = "dev", warehouse_id
        self.rest = {"/api/2.0/domains": DOMAINS, "/api/2.0/knowledge/pages": PAGES, **(rest or {})}
        self.defs = {VIEW: YAML, **(defs or {})}
        self.kinds, self.described = {}, {}
        self.views, self.cert = views, cert
        self.calls = []

    def query(self, sql, params=None, max_rows=5000):
        self.calls.append(("sql", sql))
        if not self.warehouse_id:
            raise RuntimeError("No SQL warehouse selected.")
        if sql.startswith("DESCRIBE TABLE EXTENDED"):
            view = ".".join(re.findall(r"`([^`]+)`", sql.split(" AS JSON")[0]))
            doc = self.described.get(view, RuntimeError("[INSUFFICIENT_PERMISSIONS] cannot describe"))
            if isinstance(doc, Exception):
                raise doc
            return {"columns": [{"name": "json_metadata"}], "rows": [[doc if isinstance(doc, str) else json.dumps(doc)]]}
        if "METRIC_VIEW" in sql:
            cols = ["table_catalog", "table_schema", "table_name"]
            return {"columns": [{"name": c} for c in cols], "rows": [v.split(".") for v in self.views]}
        cols = ["scope", "catalog_name", "schema_name", "table_name", "column_name", "tag_value"]
        return {"columns": [{"name": c} for c in cols], "rows": [list(r) for r in self.cert]}


@pytest.fixture
def fake(monkeypatch, tmp_path):
    ex = FakeExplorer()
    ex.root = tmp_path / "cache" / "dev"  # where the certification cache lands, as on a real Explorer

    def api_get(explorer, path, query=None):
        explorer.calls.append(("GET", path, dict(query or {})))
        value = explorer.rest[path]
        if isinstance(value, Exception):
            raise value
        if callable(value):
            return value(query or {})
        return value

    def table_metric_info(explorer, full_name):
        explorer.calls.append(("table", full_name))
        value = explorer.defs[full_name]
        if isinstance(value, Exception):
            raise value
        return {"definition": value, "kinds": explorer.kinds.get(full_name, {})}

    monkeypatch.setattr(dbx, "api_get", api_get)
    monkeypatch.setattr(dbx, "table_metric_info", table_metric_info)
    return ex


@pytest.fixture
def store():
    with rel.Store(":memory:") as s:
        yield s


def by_name(store):
    return {c.name: c for c in store.concepts()}


# ---------- the plan ----------

def test_plan_lists_every_call():
    plan = ontology.plan("wh-1")
    ids = [s["id"] for s in plan["steps"]]
    assert ids == ["domains", "pages", "metric_views", "metric_definitions", "metric_describe", "certification"]
    rest = [s for s in plan["steps"] if s["kind"] == "rest"]
    assert all(s["method"] == "GET" for s in rest)
    assert [s["path"] for s in rest] == ["/api/2.0/domains", "/api/2.0/knowledge/pages", "/api/2.1/unity-catalog/tables/{full_name}"]
    sql = next(s for s in plan["steps"] if s["id"] == "metric_views")
    assert "system.information_schema.tables" in sql["sql"] and "METRIC_VIEW" in sql["sql"]
    describe = next(s for s in plan["steps"] if s["id"] == "metric_describe")
    assert describe["kind"] == "sql" and describe["sql"] == "DESCRIBE TABLE EXTENDED <catalog>.<schema>.<view> AS JSON"
    cert = next(s for s in plan["steps"] if s["id"] == "certification")
    assert cert["kind"] == "sql" and cert["sql"] == ontology.CERT_SQL
    assert plan["warehouse_id"] == "wh-1" and plan["row_cap"] == ontology.VIEW_CAP


# ---------- parsing ----------

def test_parse_metric_view():
    got = ontology.parse_metric_view(YAML)
    assert [(m["name"], m["label"], m["kind"]) for m in got] == [
        ("total_revenue", "Total revenue", "measure"), ("order_count", "order_count", "measure"),
        ("order_month", "Order month", "dimension"), ("region", "region", "dimension")]
    assert got[0]["synonyms"] == ["sales", "turnover"] and got[0]["comment"] == "Sum of order amounts"


@pytest.mark.parametrize("text, message", [
    ("a: [", "not valid YAML"), ("- a\n- b", "not a YAML mapping"), ("version: 1.1\nsource: x", "no measures or dimensions"),
    ("", "not a YAML mapping")])
def test_parse_metric_view_rejects(text, message):
    with pytest.raises(ValueError, match=message):
        ontology.parse_metric_view(text)


def test_parse_metric_view_ignores_malformed_entries():
    got = ontology.parse_metric_view("measures:\n  - just a string\n  - {expr: 1}\n  - {name: ok, synonyms: oops}\n")
    assert [(m["name"], m["synonyms"]) for m in got] == [("ok", [])]


def test_domain_labels_and_page_fields_accept_camel_case(fake, store):
    fake.rest["/api/2.0/domains"] = {"domains": [{"domainId": "d1", "tagKey": "fin", "displayName": "Finance"}]}
    fake.rest["/api/2.0/knowledge/pages"] = {"pages": [{"name": "p", "domain": "d1", "displayName": "Churn", "state": "published"}]}
    ontology.run(fake, store)
    c = by_name(store)["Churn"]
    assert c.domain == "Finance" and c.status == "reviewed"


def test_domain_falls_back_to_tag_key_and_unknown_domain_to_last_segment(fake, store):
    fake.rest["/api/2.0/knowledge/pages"] = {"pages": [
        {"name": "a", "domain": "domains/d2", "display_name": "A"},
        {"name": "b", "domain": "domains/zzz", "display_name": "B"},
        {"name": "c", "display_name": "C"}]}
    ontology.run(fake, store)
    got = by_name(store)
    assert (got["A"].domain, got["B"].domain, got["C"].domain) == ("ops", "zzz", None)


# ---------- the first run ----------

def test_first_run_creates_pages_and_metric_concepts(fake, store):
    report = ontology.run(fake, store)
    got = by_name(store)
    assert set(got) == {"Churn", "Backlog", "Total revenue", "order_count", "Order month", "region"}
    churn = got["Churn"]
    assert churn.status == "reviewed" and churn.domain == "Finance" and churn.synonyms == ["attrition"]
    assert churn.definition == "Customers leaving.\n\n## Detail\nNo order in 90 days."
    assert churn.provenance.origin == "ontology" and churn.provenance.source_ref == "knowledge/pages/p1"
    assert got["Backlog"].status == "draft" and got["Backlog"].definition == ""
    rev = got["Total revenue"]
    assert rev.status == "draft" and rev.synonyms == ["sales", "turnover"] and rev.definition == "Sum of order amounts"
    assert rev.provenance.source_ref == f"{VIEW}#total_revenue" and rev.provenance.origin == "ontology"
    [measure] = store.concept_links(rev.id)
    assert (measure.target.table, measure.target.column, measure.relation) == (VIEW, "total_revenue", "measures")
    assert measure.provenance.origin == "ontology" and measure.provenance.source_ref == f"{VIEW}#total_revenue"
    [dim] = store.concept_links(got["Order month"].id)
    assert (dim.target.column, dim.relation) == ("order_month", "describes")
    assert sorted(e["name"] for e in report["created"]) == sorted(got)
    assert report["updated"] == [] and report["skipped"] == [] and report["unchanged"] == 0
    assert {k: v["status"] for k, v in report["sources"].items()} == {
        "domains": "ok", "pages": "ok", "metric_views": "ok", "certification": "ok"}
    assert report["sources"]["metric_views"]["unreadable"] == 0


def test_the_run_reads_only(fake, store):
    ontology.run(fake, store)
    assert [c for c in fake.calls if c[0] not in ("GET", "table", "sql")] == []
    assert all(c[0] != "GET" or c[1] in ("/api/2.0/domains", "/api/2.0/knowledge/pages") for c in fake.calls)
    sqls = [c[1] for c in fake.calls if c[0] == "sql"]
    assert len(sqls) == 3  # metric views, one DESCRIBE per view, certification
    assert all(q.lstrip().upper().startswith(("SELECT", "DESCRIBE TABLE EXTENDED")) for q in sqls)
    assert sqls[1] == "DESCRIBE TABLE EXTENDED `main`.`sales`.`sales_metrics` AS JSON"


def test_pagination_follows_the_token(fake, store):
    pages = [PAGES["pages"][0], PAGES["pages"][1]]

    def serve(query):
        return {"pages": [pages[1]]} if query.get("page_token") == "t2" else {"pages": [pages[0]], "next_page_token": "t2"}

    fake.rest["/api/2.0/knowledge/pages"] = serve
    ontology.run(fake, store)
    assert {"Churn", "Backlog"} <= set(by_name(store))
    gets = [c for c in fake.calls if c[:2] == ("GET", "/api/2.0/knowledge/pages")]
    assert [g[2] for g in gets] == [{}, {"page_token": "t2"}]


def test_page_without_a_name_or_label_is_skipped(fake, store):
    fake.rest["/api/2.0/knowledge/pages"] = {"pages": [{"name": "x"}, {"display_name": "No name"}, PAGE]}
    report = ontology.run(fake, store)
    reasons = sorted(s["reason"] for s in report["skipped"])
    assert len(reasons) == 2 and "display_name" in reasons[0] + reasons[1] and "name" in reasons[0] + reasons[1]
    assert "Churn" in by_name(store)


def test_name_clash_with_a_manual_concept(fake, store):
    concepts.create(store, concepts.parse_create({"name": "churn"}))
    concepts.create(store, concepts.parse_create({"name": "Backlog"}))
    concepts.create(store, concepts.parse_create({"name": "Backlog (ontology)"}))
    report = ontology.run(fake, store)
    got = by_name(store)
    assert "Churn (ontology)" in got and "Backlog" in got and got["Backlog"].provenance.origin == "manual"
    assert [s["name"] for s in report["skipped"]] == ["Backlog"]
    assert "already exists" in report["skipped"][0]["reason"]


def test_same_display_name_in_two_metric_views(fake, store):
    other = "main.sales.other_metrics"
    fake.views = (VIEW, other)
    fake.defs[other] = "measures:\n  - {name: total_revenue, display_name: Total revenue}\n"
    ontology.run(fake, store)
    assert {"Total revenue", "Total revenue (other_metrics)"} <= set(by_name(store))


# ---------- metric view metadata from DESCRIBE TABLE EXTENDED ... AS JSON ----------

# What the tables API's YAML keeps: names and expressions only. The rest comes from DESCRIBE.
STRIPPED = """
version: 1.1
source: main.sales.orders
dimensions:
  - {name: order_month, expr: "date_trunc('month', order_date)"}
  - {name: Market Segment, expr: segment}
measures:
  - {name: total_revenue, expr: SUM(amount)}
"""
DESCRIBED = {"table_name": "sales_metrics", "catalog_name": "main", "schema_name": "sales", "comment": "A view", "view_text": STRIPPED,
             "columns": [
                 {"name": "order_month", "type": {"name": "date"}, "comment": "Month the order was placed",
                  "metadata": {"display_name": "Order month", "synonyms": ["month", "period"]}},
                 {"name": "Market Segment", "type": {"name": "string"}, "comment": "Market segment of the customer.",
                  "metadata": {"display_name": "Market segment", "synonyms": ["segment", "customer segment"]}},
                 {"name": "total_revenue", "type": {"name": "decimal"}, "comment": "Sum of order amounts",
                  "metadata": {"display_name": "Total revenue", "synonyms": ["sales", "turnover"]}}]}
KINDS = {"order_month": "dimension", "Market Segment": "dimension", "total_revenue": "measure"}


@pytest.fixture
def described(fake):
    fake.defs[VIEW], fake.described[VIEW], fake.kinds[VIEW] = STRIPPED, DESCRIBED, KINDS
    return fake


def test_describe_supplies_display_name_synonyms_and_comment(described, store):
    ontology.run(described, store)
    got = by_name(store)
    seg = got["Market segment"]  # named by display_name, not the column name "Market Segment"
    assert seg.synonyms == ["segment", "customer segment"] and seg.definition == "Market segment of the customer."
    assert seg.provenance.source_ref == f"{VIEW}#Market Segment" and "Market Segment" not in got
    rev = got["Total revenue"]
    assert rev.synonyms == ["sales", "turnover"] and rev.definition == "Sum of order amounts"
    assert [(e.target.column, e.relation) for e in store.concept_links(rev.id)] == [("total_revenue", "measures")]
    assert [(e.target.column, e.relation) for e in store.concept_links(seg.id)] == [("Market Segment", "describes")]


def test_kinds_come_from_the_tables_api_columns_else_the_yaml(described, store):
    described.kinds[VIEW] = {"order_month": "measure"}  # the tables API wins over the YAML
    ontology.run(described, store)
    got = by_name(store)
    assert [e.relation for e in store.concept_links(got["Order month"].id)] == ["measures"]
    assert [e.relation for e in store.concept_links(got["Total revenue"].id)] == ["measures"]  # no API kind: the YAML says measure
    assert [e.relation for e in store.concept_links(got["Market segment"].id)] == ["describes"]


def test_a_column_missing_from_the_yaml_and_the_api_is_a_dimension(described, store):
    described.kinds[VIEW] = {}
    described.defs[VIEW] = "version: 1.1\nmeasures: [{name: other}]\n"
    ontology.run(described, store)
    assert [e.relation for e in store.concept_links(by_name(store)["Order month"].id)] == ["describes"]


def test_a_failed_describe_falls_back_to_the_yaml(fake, store):
    fake.defs[VIEW] = YAML  # comment, display_name and synonyms are in this YAML
    fake.described[VIEW] = RuntimeError("[INSUFFICIENT_PERMISSIONS]")
    report = ontology.run(fake, store)
    assert report["sources"]["metric_views"] == {"status": "ok", "count": 1, "unreadable": 0}
    assert by_name(store)["Total revenue"].synonyms == ["sales", "turnover"]


def test_describe_fills_gaps_from_the_yaml_and_tolerates_odd_shapes(fake, store):
    fake.defs[VIEW] = YAML
    fake.described[VIEW] = {"columns": [{"name": "total_revenue", "comment": "", "metadata": {"synonyms": "oops"}},
                                        {"comment": "no name"}, "junk", {"name": "region", "metadata": None}]}
    ontology.run(fake, store)
    got = by_name(store)
    assert got["Total revenue"].synonyms == ["sales", "turnover"] and got["Total revenue"].definition == "Sum of order amounts"
    assert "region" in got and len(store.concepts()) == 4  # two pages, and only the two named columns


def test_a_describe_with_no_usable_json_falls_back(fake, store):
    for bad in ("not json", "[]", {"columns": "x"}, {"no": "columns"}):
        fake.described[VIEW] = bad
        assert ontology.run(fake, store)["sources"]["metric_views"]["unreadable"] == 0
    assert "Total revenue" in by_name(store)


def test_describe_alone_is_enough_when_the_tables_api_fails(described, store):
    described.defs[VIEW] = errors.PermissionDenied("no")
    report = ontology.run(described, store)
    assert report["unreadable"] == [] and "Market segment" in by_name(store)


def test_a_view_with_no_describe_and_no_definition_is_unreadable(fake, store):
    fake.defs[VIEW] = None
    assert ontology.run(fake, store)["unreadable"][0]["reason"] == "the tables API returned no view definition"


def test_the_describe_statement_quotes_each_name_part(fake, store):
    fake.views = ("my cat.sales.we`ird",)
    fake.defs["my cat.sales.we`ird"] = YAML
    ontology.run(fake, store)
    assert "DESCRIBE TABLE EXTENDED `my cat`.`sales`.`we``ird` AS JSON" in [c[1] for c in fake.calls if c[0] == "sql"]


def test_describe_runs_once_per_view_and_nothing_else_is_written(described, store):
    ontology.run(described, store)
    assert len([c for c in described.calls if c[0] == "sql" and c[1].startswith("DESCRIBE")]) == 1


def test_a_rerun_after_describe_renames_the_old_concepts_instead_of_duplicating(fake, store):
    """Before: the YAML kept no display names, so the concept was named by the column name. After: display_name."""
    fake.defs[VIEW] = STRIPPED
    ontology.run(fake, store)  # DESCRIBE fails here: the older behavior
    old = by_name(store)
    assert "Market Segment" in old and "total_revenue" in old
    ids = {c.provenance.source_ref: c.id for c in store.concepts() if c.provenance.origin == "ontology"
           and c.provenance.source_ref.startswith(VIEW)}
    fake.described[VIEW], fake.kinds[VIEW] = DESCRIBED, KINDS
    report = ontology.run(fake, store)
    got = by_name(store)
    assert report["created"] == [] and "Market Segment" not in got and "total_revenue" not in got
    assert {c.provenance.source_ref: c.id for c in store.concepts() if c.provenance.source_ref.startswith(VIEW)
            and c.provenance.origin == "ontology"} == ids  # the same concepts, by source_ref
    seg = got["Market segment"]
    assert seg.id == ids[f"{VIEW}#Market Segment"] and seg.synonyms == ["segment", "customer segment"]
    assert seg.definition == "Market segment of the customer."
    assert sorted(next(u for u in report["updated"] if u["id"] == seg.id)["fields"]) == ["definition", "name", "synonyms"]
    assert sum(len(store.concept_links(c.id)) for c in store.concepts()) == 3  # links unchanged
    assert ontology.run(fake, store)["updated"] == []  # and a further rerun is quiet


def test_a_users_rename_survives_a_display_name_change(described, store):
    ontology.run(described, store)
    seg = by_name(store)["Market segment"]
    concepts.update(store, seg.id, concepts.parse_patch({"name": "Segment"}))
    described.described[VIEW] = {**DESCRIBED, "columns": [
        {**DESCRIBED["columns"][0]},
        {**DESCRIBED["columns"][1], "metadata": {"display_name": "Customer segment", "synonyms": ["segment"]}},
        DESCRIBED["columns"][2]]}
    report = ontology.run(described, store)
    got = by_name(store)
    assert "Segment" in got and "Customer segment" not in got and report["created"] == []
    entry = next(u for u in report["updated"] if u["id"] == seg.id)
    assert entry["kept"] == ["name"] and entry["fields"] == ["synonyms"]


def test_a_case_only_display_name_change_updates_in_place(described, store):
    described.described[VIEW] = {**DESCRIBED, "columns": [
        DESCRIBED["columns"][0],
        {**DESCRIBED["columns"][1], "metadata": {"display_name": "MARKET SEGMENT"}}, DESCRIBED["columns"][2]]}
    ontology.run(described, store)
    described.described[VIEW] = DESCRIBED
    report = ontology.run(described, store)
    assert "Market segment" in by_name(store) and "MARKET SEGMENT" not in by_name(store) and report["created"] == []


# ---------- reruns ----------

def test_second_run_changes_nothing(fake, store):
    ontology.run(fake, store)
    before = [c.model_dump() for c in store.concepts()]
    report = ontology.run(fake, store)
    assert report["created"] == [] and report["updated"] == [] and report["unchanged"] == 6
    after = [c.model_dump() for c in store.concepts()]
    for a, b in zip(before, after):
        assert {**a, "provenance": None} == {**b, "provenance": None}
    assert sum(len(store.concept_links(c.id)) for c in store.concepts()) == 4


def test_rerun_updates_what_the_source_changed_and_keeps_user_edits(fake, store):
    ontology.run(fake, store)
    churn = by_name(store)["Churn"]
    concepts.update(store, churn.id, concepts.parse_patch({"synonyms": ["attrition", "lapse"], "status": "certified"}))
    fake.rest["/api/2.0/knowledge/pages"] = {"pages": [
        {**PAGE, "description": "Customers who stopped buying.", "state": "DRAFT", "domain": "domains/d2"}, PAGES["pages"][1]]}
    report = ontology.run(fake, store)
    c = by_name(store)["Churn"]
    assert c.definition.startswith("Customers who stopped buying.")  # the source changed it, the user did not
    assert c.domain == "ops"
    assert c.synonyms == ["attrition", "lapse"]  # the user's edit; the source did not change synonyms
    assert c.status == "certified"  # the source moved to draft, but the user had changed it, so theirs stands
    [entry] = [u for u in report["updated"] if u["name"] == "Churn"]
    assert sorted(entry["fields"]) == ["definition", "domain"] and entry["kept"] == ["status"]
    assert report["created"] == [] and len(store.concepts()) == 6


def test_rerun_keeps_a_rename_and_matches_by_source_ref(fake, store):
    ontology.run(fake, store)
    c = by_name(store)["Churn"]
    concepts.update(store, c.id, concepts.parse_patch({"name": "Attrition"}))
    report = ontology.run(fake, store)
    assert "Attrition" in by_name(store) and "Churn" not in by_name(store)
    assert report["created"] == [] and len(store.concepts()) == 6


def test_a_source_rename_that_clashes_is_not_applied(fake, store):
    ontology.run(fake, store)
    concepts.create(store, concepts.parse_create({"name": "Churn rate"}))
    fake.rest["/api/2.0/knowledge/pages"] = {"pages": [{**PAGE, "display_name": "Churn rate"}, PAGES["pages"][1]]}
    report = ontology.run(fake, store)
    assert "Churn" in by_name(store)
    assert all(u["name"] != "Churn" for u in report["updated"])
    [note] = [s for s in report["skipped"] if s["name"] == "Churn"]
    assert "Churn rate" in note["reason"] and "name stays" in note["reason"]


def test_links_are_added_and_only_stale_ontology_links_removed(fake, store):
    ontology.run(fake, store)
    rev = by_name(store)["Total revenue"]
    mine = concepts.add_link(store, rev.id, concepts.parse_link(
        {"target": {"table": "main.sales.orders", "column": "amount"}, "relation": "defines"}))[0]
    # the measure now points at a renamed column and a new measure appears; the old column link goes
    fake.defs[VIEW] = YAML.replace("name: total_revenue", "name: revenue_total").replace("name: order_count", "name: orders")
    report = ontology.run(fake, store)
    got = by_name(store)
    targets = {(e.target.column, e.provenance.origin) for e in store.concept_links(rev.id)}
    assert targets == {("amount", "user")}  # the stale ontology link is gone; a user link is never touched
    assert store.get(mine.id)
    assert any(s["name"] == "Total revenue" for s in report["stale"])
    stale = [s for s in report["stale"] if s["name"] == "Total revenue"][0]
    assert stale["links_removed"] == 1
    assert "order_count" in got  # a stale concept stays
    assert "Total revenue (sales_metrics)" in got and "orders" in got  # the new refs get concepts; the name was taken


def test_a_link_the_user_already_made_is_left_alone(fake, store):
    ontology.run(fake, store)
    ontology_ids = {e.id for c in store.concepts() for e in store.concept_links(c.id)}
    rev = by_name(store)["Total revenue"]
    [e] = store.concept_links(rev.id)
    store.delete(e.id)
    concepts.add_link(store, rev.id, concepts.parse_link({"target": {"table": VIEW, "column": "total_revenue"}, "relation": "defines"}))
    report = ontology.run(fake, store)
    [kept] = store.concept_links(rev.id)
    assert kept.provenance.origin == "user" and kept.relation == "defines"
    assert all(u["name"] != "Total revenue" for u in report["updated"]) and ontology_ids


def test_a_definition_that_stops_parsing_leaves_its_concepts_and_links(fake, store):
    ontology.run(fake, store)
    fake.defs[VIEW] = "measures: ["
    report = ontology.run(fake, store)
    assert [u["view"] for u in report["unreadable"]] == [VIEW] and "not valid YAML" in report["unreadable"][0]["reason"]
    assert report["sources"]["metric_views"]["unreadable"] == 1 and report["stale"] == []
    assert sum(len(store.concept_links(c.id)) for c in store.concepts()) == 4


def test_an_unreadable_view_is_counted_and_the_rest_carry_on(fake, store):
    broken = "main.sales.broken"
    fake.views = (broken, "main.sales.empty", "main.sales.denied", VIEW)
    fake.defs[broken] = "not: [valid"
    fake.defs["main.sales.empty"] = None
    fake.defs["main.sales.denied"] = errors.PermissionDenied("no")
    report = ontology.run(fake, store)
    assert report["sources"]["metric_views"]["status"] == "ok" and report["sources"]["metric_views"]["unreadable"] == 3
    assert {u["view"] for u in report["unreadable"]} == {broken, "main.sales.empty", "main.sales.denied"}
    assert "Total revenue" in by_name(store)


def test_a_missing_page_stops_its_links_only_when_the_source_was_read(fake, store):
    ontology.run(fake, store)
    fake.rest["/api/2.0/knowledge/pages"] = errors.NotFound("gone")
    report = ontology.run(fake, store)
    assert report["sources"]["pages"]["status"] == "unavailable"
    assert report["stale"] == [] and "Churn" in by_name(store)


# ---------- endpoints that are not there ----------

@pytest.mark.parametrize("error", [errors.NotFound("no such endpoint"), errors.PermissionDenied("forbidden"),
                                   RuntimeError("HTTP 404 Not Found"), RuntimeError("403 Forbidden")])
def test_unavailable_endpoint_is_reported_and_the_rest_carry_on(fake, store, error):
    fake.rest["/api/2.0/knowledge/pages"] = error
    fake.rest["/api/2.0/domains"] = error
    report = ontology.run(fake, store)
    for key in ("domains", "pages"):
        assert report["sources"][key]["status"] == "unavailable"
        assert report["sources"][key]["message"] == "not available on this workspace"
    assert "Total revenue" in by_name(store) and "Churn" not in by_name(store)


def test_other_errors_are_failures_not_unavailable(fake, store):
    fake.rest["/api/2.0/domains"] = RuntimeError("boom")
    report = ontology.run(fake, store)
    assert report["sources"]["domains"]["status"] == "failed" and "boom" in report["sources"]["domains"]["message"]
    assert "Churn" in by_name(store)


def test_no_warehouse_fails_only_the_metric_views(fake, store):
    fake.warehouse_id = None
    report = ontology.run(fake, store)
    assert report["sources"]["metric_views"]["status"] == "failed"
    assert "warehouse" in report["sources"]["metric_views"]["message"].lower()
    assert report["sources"]["pages"]["status"] == "ok" and "Churn" in by_name(store)


def test_unexpected_response_shapes_do_not_crash(fake, store):
    fake.rest["/api/2.0/domains"] = {"unexpected": "shape"}
    fake.rest["/api/2.0/knowledge/pages"] = {"items": [PAGE, "junk", 3]}
    report = ontology.run(fake, store)
    assert report["sources"]["domains"]["count"] == 0 and "Churn" in by_name(store)
    fake.rest["/api/2.0/knowledge/pages"] = []
    assert ontology.run(fake, store)["sources"]["pages"]["count"] == 0


# ---------- certification ----------

CERT = [("table", "main", "sales", "orders", None, "certified"), ("table", "main", "sales", "old", None, "Deprecated"),
        ("column", "main", "sales", "orders", "amount", "certified"), ("table", "main", "sales", "x", None, "draft"),
        ("column", "main", "sales", "old", "id", "deprecated")]


def test_certification(fake):
    fake.cert = CERT
    got = ontology.certification(fake)
    assert got["tables"] == {"main.sales.orders": "certified", "main.sales.old": "deprecated"}
    assert got["columns"] == {"main.sales.orders#amount": "certified", "main.sales.old#id": "deprecated"}
    assert got["ignored"] == 1 and got["truncated"] is False
    sql = [c[1] for c in fake.calls if c[0] == "sql"][0]
    assert "system.certification_status" in sql and "table_tags" in sql and "column_tags" in sql


# ---------- Suggest from tags skips system tags ----------

def test_tag_suggestions_skip_system_tags(store):
    cols = ["scope", "catalog_name", "schema_name", "table_name", "column_name", "tag_name", "tag_value"]
    rows = [["table", "main", "sales", "orders", None, "system.certification_status", "certified"],
            ["table", "main", "sales", "orders", None, "domain", "sales"],
            ["column", "main", "sales", "orders", "amount", "system.certification_status", "certified"]]
    got = concepts.tag_run(store, {"columns": [{"name": c} for c in cols], "rows": rows})
    assert [c["name"] for c in got["created"]] == ["domain=sales"]
    assert got["skipped"] == [{"name": "system.certification_status=certified",
                               "reason": "a Databricks system tag, shown as a badge instead"}]
    assert [c.name for c in store.concepts()] == ["domain=sales"]


# ---------- routes ----------

@pytest.fixture
def client(tmp_path, monkeypatch, fake):
    monkeypatch.setattr(dbx, "DATA", tmp_path)
    monkeypatch.setitem(app_module.STATE, "ex", fake)
    c = app_module.app.test_client()
    c.fake = fake
    return c


def test_plan_and_run_routes(client):
    plan = client.get("/api/concepts/import/plan").json
    assert plan["warehouse_id"] == "wh-1" and len(plan["steps"]) == 6
    assert client.fake.calls == []  # a plan runs nothing
    run = client.post("/api/concepts/import/run").json
    assert len(run["created"]) == 6
    again = client.post("/api/concepts/import/run").json
    assert again["created"] == [] and again["unchanged"] == 6
    listed = client.get("/api/concepts?q=revenue").json["concepts"]
    assert listed[0]["provenance"]["origin"] == "ontology" and listed[0]["link_count"] == 1


def test_certification_get_never_queries_and_is_empty_with_no_cache(client):
    client.fake.cert = CERT
    client.fake.query = lambda *a, **k: pytest.fail("the warehouse was queried")
    r = client.get("/api/certification")
    assert r.status_code == 200
    assert r.json == {"tables": {}, "columns": {}, "ignored": 0, "truncated": False, "fetched_at": None}
    assert client.fake.calls == []


def test_certification_get_never_queries_even_with_a_cache(client):
    client.fake.cert = CERT
    assert client.post("/api/certification/refresh").status_code == 200
    client.fake.calls.clear()
    client.fake.query = lambda *a, **k: pytest.fail("the warehouse was queried")
    got = client.get("/api/certification").json
    assert got["tables"]["main.sales.orders"] == "certified" and client.fake.calls == []


def test_certification_get_needs_no_warehouse(client):
    client.fake.warehouse_id = None
    r = client.get("/api/certification")
    assert r.status_code == 200 and r.json["fetched_at"] is None and "needs_warehouse" not in r.json


def test_certification_refresh_writes_the_cache_and_get_returns_it(client):
    client.fake.cert = CERT
    r = client.post("/api/certification/refresh")
    assert r.status_code == 200
    got = r.json
    assert got["tables"] == {"main.sales.orders": "certified", "main.sales.old": "deprecated"}
    assert got["columns"]["main.sales.orders#amount"] == "certified"
    assert got["ignored"] == 1 and got["truncated"] is False and got["fetched_at"]
    assert len([c for c in client.fake.calls if c[0] == "sql"]) == 1
    assert (client.fake.root / "certification.json").is_file()
    assert client.get("/api/certification").json == got
    assert len([c for c in client.fake.calls if c[0] == "sql"]) == 1  # the read did not query again


def test_certification_refresh_replaces_the_cache(client):
    client.fake.cert = CERT
    client.post("/api/certification/refresh")
    client.fake.cert = [("table", "main", "sales", "customers", None, "certified")]
    client.post("/api/certification/refresh")
    assert client.get("/api/certification").json["tables"] == {"main.sales.customers": "certified"}


def test_certification_refresh_needs_a_warehouse(client):
    client.fake.warehouse_id = None
    r = client.post("/api/certification/refresh")
    assert r.status_code == 400 and "warehouse" in r.json["error"].lower()
    assert client.fake.calls == []
    assert not (client.fake.root / "certification.json").exists()


def test_a_failed_refresh_keeps_the_old_cache(client):
    client.fake.cert = CERT
    client.post("/api/certification/refresh")
    before = client.get("/api/certification").json

    def boom(*a, **k):
        raise RuntimeError("warehouse is stopped")

    client.fake.query = boom
    assert client.post("/api/certification/refresh").status_code == 500
    assert client.get("/api/certification").json == before


def test_a_corrupt_cache_reads_as_empty(client):
    client.fake.root.mkdir(parents=True)
    (client.fake.root / "certification.json").write_text("{not json", encoding="utf-8")
    assert client.get("/api/certification").json["fetched_at"] is None


def test_the_import_run_refreshes_certification(client):
    client.fake.cert = CERT
    run = client.post("/api/concepts/import/run").json
    assert run["sources"]["certification"] == {"status": "ok", "count": 4}
    assert client.get("/api/certification").json["tables"]["main.sales.orders"] == "certified"


def test_the_import_run_reports_certification_failing_without_a_warehouse(fake, store):
    fake.warehouse_id = None
    report = ontology.run(fake, store)
    assert report["sources"]["certification"]["status"] == "failed"
    assert "warehouse" in report["sources"]["certification"]["message"].lower()
    assert not (fake.root / "certification.json").exists()
    assert report["sources"]["pages"]["status"] == "ok"


def test_routes_need_a_connection(monkeypatch):
    monkeypatch.setitem(app_module.STATE, "ex", None)
    c = app_module.app.test_client()
    assert c.get("/api/concepts/import/plan").status_code == 500
    assert c.get("/api/certification").status_code == 500
    assert c.post("/api/certification/refresh").status_code == 500


# ---------- demo mode: the whole flow against the fake workspace ----------

@pytest.fixture
def demo_client(monkeypatch, tmp_path):
    import demo
    monkeypatch.setattr(dbx, "DEMO", True)
    monkeypatch.setattr(dbx, "WorkspaceClient", demo.FakeWorkspaceClient)
    monkeypatch.setattr(dbx, "CACHE", tmp_path / "cache")
    monkeypatch.setattr(dbx, "LOGS", tmp_path)
    monkeypatch.setattr(dbx, "DATA", tmp_path)
    monkeypatch.setattr(demo, "NORMAL_DELAY", 0)
    monkeypatch.setitem(app_module.STATE, "ex", None)
    c = app_module.app.test_client()
    assert c.post("/api/connect", json={"profile": "demo"}).status_code == 200
    c.post("/api/warehouse", json={"id": "demo-wh-1"})
    return c


def test_import_flow_in_demo_mode(demo_client):
    c = demo_client
    plan = c.get("/api/concepts/import/plan").json
    assert plan["warehouse_id"] == "demo-wh-1" and "METRIC_VIEW" in plan["steps"][2]["sql"]
    run = c.post("/api/concepts/import/run").json
    assert {k: v["status"] for k, v in run["sources"].items()} == {
        "domains": "ok", "pages": "ok", "metric_views": "ok", "certification": "ok"}
    assert run["sources"]["pages"]["count"] == 3  # two requests: the fake serves two pages at a time
    names = sorted(e["name"] for e in run["created"])
    assert names == ["Active customer", "Customer", "Headcount", "Order count", "Order month", "Total revenue", "status"]
    customer = next(x for x in c.get("/api/concepts?q=customer").json["concepts"] if x["name"] == "Customer")
    assert customer["domain"] == "Sales" and customer["status"] == "reviewed" and "client" in customer["synonyms"]
    assert c.get("/api/concepts?q=headcount").json["concepts"][0]["domain"] == "people"  # no display_name: the tag key
    month = next(x for x in c.get("/api/concepts?q=month").json["concepts"] if x["name"] == "Order month")
    assert month["synonyms"] == ["month", "period"]  # from DESCRIBE: the tables API's YAML has none
    revenue = c.get("/api/concepts?q=turnover").json["concepts"][0]
    assert revenue["definition"] == "Sum of order amounts in dollars"
    link = c.get(f"/api/concepts/{revenue['id']}").json["links"][0]
    assert link["target"] == {"table": "demo.sales.sales_metrics", "column": "total_revenue"} and link["relation"] == "measures"
    again = c.post("/api/concepts/import/run").json
    assert again["created"] == [] and again["updated"] == [] and again["unchanged"] == len(run["created"])


def test_certification_and_system_tags_in_demo_mode(demo_client):
    assert demo_client.get("/api/certification").json["fetched_at"] is None  # nothing is read until asked
    got = demo_client.post("/api/certification/refresh").json
    assert demo_client.get("/api/certification").json == got
    assert got["tables"]["demo.sales.orders"] == "certified" and got["tables"]["demo.sales.v_daily_revenue"] == "deprecated"
    assert got["columns"]["demo.sales.orders#discount_pct"] == "deprecated"
    run = demo_client.post("/api/concepts/suggest/run").json
    assert all(not c["name"].startswith("system.") for c in run["created"])
    assert [s["name"] for s in run["skipped"]] == ["system.certification_status=certified", "system.certification_status=deprecated"]
