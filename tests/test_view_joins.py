"""Joins read from view definitions, and column lineage without a warehouse (REST API and view SQL)."""
import pytest

from databricks_explore import app as app_module
from databricks_explore import dbx, demo, sqltools
from databricks_explore import relationships as rel

O, R, C, V = "demo.sales.orders", "demo.sales.returns", "demo.sales.customers", "demo.sales.v_daily_revenue"
VIEW_SQL = "SELECT o.order_date, r.reason, sum(o.amount) AS revenue FROM demo.sales.orders o JOIN demo.sales.returns r ON o.order_id = r.order_id GROUP BY 1, 2"


def view_info(sql=VIEW_SQL, table_type="VIEW", deps=()):
    return {"table_type": table_type, "view_definition": sql, "columns": [{"name": "order_date"}, {"name": "reason"}, {"name": "revenue"}],
            "view_dependencies": {"dependencies": [{"table": {"table_full_name": d}} for d in deps]}}


@pytest.fixture
def store():
    s = rel.Store(":memory:")
    yield s
    s.close()


# ---------- extraction ----------

def test_a_views_join_is_read_from_its_sql_between_its_base_tables():
    assert rel.view_join_groups("c.s.v", view_info()) == [[(O, "order_id", R, "order_id")]]


def test_short_names_are_qualified_from_the_views_own_catalog_and_schema():
    sql = "SELECT * FROM orders o JOIN returns r ON o.order_id = r.order_id"
    assert rel.view_join_groups("demo.sales.v", view_info(sql)) == [[(O, "order_id", R, "order_id")]]


def test_a_composite_condition_is_one_group_and_a_lone_pair_another():
    sql = ("SELECT * FROM a.b.x x JOIN a.b.y y ON x.p = y.p AND x.q = y.q JOIN a.b.z z ON z.k = x.k")
    groups = rel.view_join_groups("a.b.v", view_info(sql))
    assert sorted(len(g) for g in groups) == [1, 2]
    assert [("a.b.x", "p", "a.b.y", "p"), ("a.b.x", "q", "a.b.y", "q")] in groups


@pytest.mark.parametrize("info", [
    view_info(table_type="MANAGED"),                                   # a table has no definition to read
    view_info("version: 0.1\nsource: demo.sales.orders\njoins: []", "VIEW"),  # a metric view's YAML
    view_info("SELECT FROM WHERE ((("),                                # does not parse
    view_info("SELECT * FROM a.b.x JOIN system.access.audit s ON x.id = s.id"),  # Databricks' own tables
    view_info("SELECT * FROM a.b.x x JOIN a.b.x y ON x.id = y.parent_id"),       # a self join is not a relationship of two tables
    None,
])
def test_anything_that_is_not_a_sql_join_between_two_tables_gives_nothing(info):
    assert rel.view_join_groups("a.b.v", info) == []


def test_a_materialized_view_counts_as_a_view():
    assert rel.view_join_groups("c.s.mv", view_info(table_type="MATERIALIZED_VIEW")) == [[(O, "order_id", R, "order_id")]]


# ---------- the store ----------

def test_replacing_a_views_joins_reports_a_change_only_when_there_is_one(store):
    groups = rel.view_join_groups("c.s.v", view_info())
    assert store.replace_view_joins("c.s.v", groups) is True
    assert store.replace_view_joins("c.s.v", groups) is False
    assert store.replace_view_joins("C.S.V", []) is True  # the view stopped joining
    assert store.view_joins() == []


def test_view_joins_can_be_asked_for_by_table_or_by_view(store):
    store.replace_view_joins("c.s.v", [[(O, "order_id", R, "order_id")]])
    store.replace_view_joins("c.s.w", [[(O, "customer_id", C, "customer_id")]])
    assert [j["view"] for j in store.view_joins(R)] == ["c.s.v"]
    assert [j["view"] for j in store.view_joins(O)] == ["c.s.v", "c.s.w"]
    assert [j["view"] for j in store.view_joins(view="c.s.w")] == ["c.s.w"]


# ---------- join keys ----------

def mined(a, ac, b, bc, status="proposed"):
    return rel.Edge(kind="join_mined", directed=False, status=status,
                    source=rel.Endpoint(table=a, column=ac), target=rel.Endpoint(table=b, column=bc),
                    provenance=rel.Provenance(origin="query_history"), evidence=rel.Evidence(runs=7))


def keys_of(out, other):
    (j,) = [j for j in out["joins"] if j["table"] == other]
    return j["keys"]


def test_a_view_defined_join_is_a_derived_key_from_either_tables_side(store):
    store.replace_view_joins("c.s.v", [[(O, "order_id", R, "return_order_id")]])
    (k,) = keys_of(rel.join_keys(store, O), R)
    assert (k["pairs"], k["source"], k["status"], k["runs"], k["views"]) == (
        [{"here": "order_id", "there": "return_order_id"}], "view", "derived", None, ["c.s.v"])
    (k,) = keys_of(rel.join_keys(store, R), O)
    assert k["pairs"] == [{"here": "return_order_id", "there": "order_id"}]


def test_a_mined_join_that_a_view_also_defines_is_one_key_marked_with_the_view(store):
    store.upsert_mined([mined(O, "order_id", R, "order_id")])
    store.replace_view_joins("c.s.v", [[(O, "order_id", R, "order_id")]])
    store.replace_view_joins("c.s.w", [[(O, "order_id", R, "order_id")]])
    (k,) = keys_of(rel.join_keys(store, O), R)
    assert (k["source"], k["status"], k["runs"], k["views"]) == ("mined", "proposed", 7, ["c.s.v", "c.s.w"])


def test_a_rejected_mined_join_stays_rejected_though_a_view_defines_it(store):
    store.upsert_mined([mined(O, "order_id", R, "order_id", status="rejected")])
    store.replace_view_joins("c.s.v", [[(O, "order_id", R, "order_id")]])
    (k,) = keys_of(rel.join_keys(store, O), R)
    assert (k["status"], k["views"]) == ("rejected", ["c.s.v"])


def test_a_declared_foreign_key_is_marked_with_the_view_that_repeats_it(store):
    info = {"table_constraints": [{"foreign_key_constraint": {"name": "fk", "child_columns": ["order_id"], "parent_table": R,
                                                              "parent_columns": ["order_id"]}}]}
    store.replace_view_joins("c.s.v", [[(O, "order_id", R, "order_id")]])
    (k,) = keys_of(rel.join_keys(store, O, info), R)
    assert (k["source"], k["views"]) == ("fk", ["c.s.v"])


def test_other_keys_are_unchanged_and_carry_no_views_field(store):
    store.upsert_mined([mined(O, "customer_id", C, "customer_id")])
    store.replace_view_joins("c.s.v", [[(O, "order_id", R, "order_id")]])
    out = rel.join_keys(store, O)
    assert "views" not in keys_of(out, C)[0] and "view_joins" not in out


def test_the_view_itself_lists_the_joins_its_sql_defines(store):
    store.replace_view_joins("c.s.v", [[(O, "order_id", R, "order_id")]])
    assert rel.join_keys(store, "c.s.v")["view_joins"] == [
        {"left": O, "right": R, "pairs": [{"left": "order_id", "right": "order_id"}]}]


def test_a_pair_key_has_one_spelling():
    assert rel.pair_key(mined(R, "Order_ID", O, "order_id")) == (O, "order_id", R, "order_id")


# ---------- routes, through demo mode ----------

@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setattr(dbx, "DEMO", True)
    monkeypatch.setattr(dbx, "WorkspaceClient", demo.FakeWorkspaceClient)
    monkeypatch.setattr(dbx, "DATA", tmp_path)
    monkeypatch.setattr(dbx, "CACHE", tmp_path / "cache")
    monkeypatch.setattr(dbx, "LOGS", tmp_path)
    monkeypatch.setattr(demo, "NORMAL_DELAY", 0)
    monkeypatch.setitem(app_module.STATE, "ex", None)
    monkeypatch.setitem(app_module.STATE, "miner", None)
    c = app_module.app.test_client()
    assert c.post("/api/connect", json={"profile": "demo"}).status_code == 200
    return c


def give_view_a_definition(monkeypatch, sql=VIEW_SQL):
    """The demo's view has no SQL; give it one, as tables.get would."""
    ex = app_module.STATE["ex"]
    real = ex.object

    def object_(full_name, refresh=False):
        out = real(full_name, refresh)
        if full_name == V:
            out = {**out, "data": {**out["data"], "view_definition": sql}}
        return out
    monkeypatch.setattr(ex, "object", object_)


def test_opening_a_base_table_reads_the_view_built_from_it_and_Query_these_tables_gets_its_key(client, monkeypatch):
    give_view_a_definition(monkeypatch)
    client.get(f"/api/relationships?table={O}")  # the Graph adds the table: its views are read
    out = client.get(f"/api/relationships/joins?table={R}").json  # orders and returns have no declared or mined join
    (k,) = keys_of(out, O)
    assert k["source"] == "view" and k["pairs"] == [{"here": "order_id", "there": "order_id"}] and k["views"] == [V]


def test_the_joins_route_reads_the_views_itself_so_the_editor_needs_no_graph(client, monkeypatch):
    give_view_a_definition(monkeypatch)
    (k,) = keys_of(client.get(f"/api/relationships/joins?table={O}").json, R)
    assert k["source"] == "view"
    assert client.get(f"/api/relationships/joins?table={V}").json["view_joins"][0]["pairs"] == [{"left": "order_id", "right": "order_id"}]


def test_a_view_that_cannot_be_read_does_not_fail_the_request(client, monkeypatch):
    ex = app_module.STATE["ex"]
    real = ex.object
    monkeypatch.setattr(ex, "object", lambda n, refresh=False: (_ for _ in ()).throw(RuntimeError("boom")) if n == V else real(n, refresh))
    r = client.get(f"/api/relationships?table={O}")
    assert r.status_code == 200 and r.json["edges"]


def test_suggestions_say_which_views_also_join_on_a_pair(client, monkeypatch):
    give_view_a_definition(monkeypatch)
    with app_module.rel_store() as store:
        store.upsert_mined([mined(O, "order_id", R, "order_id"), mined(O, "customer_id", C, "customer_id")])
    client.get(f"/api/relationships/joins?table={O}")
    out = client.get("/api/relationships/suggestions").json
    by_pair = {(e["source"]["column"], e["target"]["column"]): e["id"] for e in out["edges"]}
    assert out["views"] == {by_pair[("order_id", "order_id")]: [V]}


# ---------- column lineage without a warehouse ----------

def column_edges(client, table, **q):
    qs = "&".join(f"{k}={v}" for k, v in q.items())
    return client.get(f"/api/relationships?table={table}&level=column&{qs}").json


def pairs_of(out):
    return {(e["source"]["table"].split(".")[-1], e["source"]["column"], e["target"]["table"].split(".")[-1], e["target"]["column"])
            for e in out["edges"] if e["kind"] == "lineage" and e["source"]["column"]}


class RestAnswers:
    """Stands in for the column-lineage endpoint: {(table, column): response}. Counts the calls."""

    def __init__(self, ex, answers):
        self.answers, self.calls, self.real = answers, [], ex.w.api_client.do

    def __call__(self, method, path, body=None, **kw):
        if path.endswith("/column-lineage"):
            self.calls.append((body["table_name"], body["column_name"]))
            return self.answers.get((body["table_name"], body["column_name"]), {})
        return self.real(method, path, body=body, **kw)


def col(table, name):
    c, s, t = table.split(".")
    return {"name": name, "catalog_name": c, "schema_name": s, "table_name": t}


def test_without_a_warehouse_column_lineage_comes_from_the_rest_api(client, monkeypatch):
    ex = app_module.STATE["ex"]
    rest = RestAnswers(ex, {(O, "amount"): {"downstream_cols": [col(V, "revenue")], "upstream_cols": []},
                            (O, "customer_id"): {"upstream_cols": [col(C, "customer_id")]}})
    monkeypatch.setattr(ex.w.api_client, "do", rest)
    out = column_edges(client, O)
    assert pairs_of(out) == {("orders", "amount", "v_daily_revenue", "revenue"), ("customers", "customer_id", "orders", "customer_id")}
    assert out["errors"] == [] and out["column_lineage_source"] == "api"
    assert all(e["status"] == "derived" and e["provenance"]["origin"] == "unity_catalog:column_lineage" for e in out["edges"]
               if e["kind"] == "lineage" and e["source"]["column"])


def test_the_rest_answer_is_cached_and_a_refresh_asks_again(client, monkeypatch):
    ex = app_module.STATE["ex"]
    rest = RestAnswers(ex, {(O, "amount"): {"downstream_cols": [col(V, "revenue")]}})
    monkeypatch.setattr(ex.w.api_client, "do", rest)
    column_edges(client, O)
    n = len(rest.calls)
    assert n == len(demo.TABLES[O][1])  # one call per column
    column_edges(client, O)
    assert len(rest.calls) == n
    column_edges(client, O, refresh=1)
    assert len(rest.calls) == 2 * n


def test_a_view_definition_fills_the_gap_for_the_views_own_columns(client, monkeypatch):
    give_view_a_definition(monkeypatch)
    out = column_edges(client, V)
    assert {("orders", "order_date", "v_daily_revenue", "order_date"), ("orders", "amount", "v_daily_revenue", "revenue")} <= pairs_of(out)
    assert out["column_lineage_source"] == "api"


def test_a_view_definition_does_not_repeat_what_the_rest_api_said(client, monkeypatch):
    give_view_a_definition(monkeypatch)
    ex = app_module.STATE["ex"]
    monkeypatch.setattr(ex.w.api_client, "do", RestAnswers(ex, {(V, "revenue"): {"upstream_cols": [col(O, "amount")]}}))
    edges = [e for e in column_edges(client, V)["edges"] if e["kind"] == "lineage" and e["source"]["column"] == "amount"]
    assert len(edges) == 1


def test_a_warehouse_is_still_preferred_when_it_works(client, monkeypatch):
    client.post("/api/warehouse", json={"id": "demo-wh-1"})
    ex = app_module.STATE["ex"]
    rest = RestAnswers(ex, {(O, "amount"): {"downstream_cols": [col(V, "revenue")]}})
    monkeypatch.setattr(ex.w.api_client, "do", rest)
    out = column_edges(client, O)
    assert out["column_lineage_source"] == "system_table" and rest.calls == []


def test_an_empty_system_table_answer_falls_back_to_the_rest_api(client, monkeypatch):
    # live on dbx-free: system.access.column_lineage had no rows for a table written minutes before, the REST API had them
    client.post("/api/warehouse", json={"id": "demo-wh-1"})
    ex = app_module.STATE["ex"]
    monkeypatch.setattr(ex, "sql", lambda *a, **k: [])
    monkeypatch.setattr(ex.w.api_client, "do", RestAnswers(ex, {(O, "amount"): {"downstream_cols": [col(V, "revenue")]}}))
    out = column_edges(client, O)
    assert out["column_lineage_source"] == "api" and ("orders", "amount", "v_daily_revenue", "revenue") in pairs_of(out)
    monkeypatch.setattr(ex.w.api_client, "do", RestAnswers(ex, {}))
    assert column_edges(client, O, refresh=1)["column_lineage_source"] == "system_table"  # nothing anywhere: the empty answer


def test_when_the_warehouse_fails_the_rest_api_answers_instead(client, monkeypatch):
    client.post("/api/warehouse", json={"id": "demo-wh-1"})
    ex = app_module.STATE["ex"]
    monkeypatch.setattr(ex, "sql", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("[WAREHOUSE_NOT_RUNNING]")))
    monkeypatch.setattr(ex.w.api_client, "do", RestAnswers(ex, {(O, "amount"): {"downstream_cols": [col(V, "revenue")]}}))
    out = column_edges(client, O)
    assert out["errors"] == [] and ("orders", "amount", "v_daily_revenue", "revenue") in pairs_of(out)


def test_with_nothing_found_and_no_warehouse_the_note_still_says_to_pick_one(client):
    out = column_edges(client, O)
    assert len(out["errors"]) == 1 and "warehouse" in out["errors"][0] and "column_lineage_source" not in out


def test_the_rest_api_failing_for_a_column_is_not_an_error(client, monkeypatch):
    ex = app_module.STATE["ex"]
    real = ex.w.api_client.do

    def broken(method, path, body=None, **kw):
        if path.endswith("/column-lineage"):
            raise RuntimeError("404 endpoint not found")
        return real(method, path, body=body, **kw)
    monkeypatch.setattr(ex.w.api_client, "do", broken)
    out = column_edges(client, O)
    assert out["errors"][0].startswith("column_lineage:") and out["edges"]


def test_view_column_lineage_traces_expressions_and_skips_what_it_cannot_name():
    sql = "SELECT o.order_id, o.amount * 2 AS dbl, concat(o.a, s.b) AS cc, count(*) AS n, 1 AS one FROM raw.orders o JOIN core.dim_store s ON o.store_id = s.store_id"
    got = sqltools.view_column_lineage(sql, ["order_id", "dbl", "cc", "n", "one", "missing"], "main", "gold")
    assert got == [("main.raw.orders", "order_id", "order_id"), ("main.raw.orders", "amount", "dbl"),
                   ("main.core.dim_store", "b", "cc"), ("main.raw.orders", "a", "cc")]  # sorted per column
    assert sqltools.view_column_lineage("SELECT * FROM a.b.c", ["x"]) == []
    assert sqltools.view_column_lineage("not sql (", ["x"]) == []
