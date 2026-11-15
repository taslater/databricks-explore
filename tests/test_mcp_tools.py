"""The catalog, relationship, mining and concept tools, against the demo workspace."""
import json

from mcp_helpers import agent, connected, env, offline_agent  # noqa: F401


def test_status_when_connected(agent):
    assert "connected: profile demo; warehouse demo-wh-1; demo mode: yes" in agent.ok("status")
    data = json.loads(agent.ok("status", format="json"))
    assert data["connected"] and data["profile"] == "demo" and data["warehouse_id"] == "demo-wh-1" and data["demo"]
    assert data["mining"] == "idle" and data["canvases"] == 0


def test_status_before_connecting_says_to_connect_in_the_app(offline_agent):
    out = offline_agent.ok("status")
    assert out.startswith("Not connected: connect a profile in the app first") and "canvas tools work" in out


def test_catalog_tools_need_the_app_connected(offline_agent):
    a = offline_agent
    for name, args in (("search_tables", {"q": "o"}), ("describe_table", {"name": "a.b.c"}), ("list_schemas", {}),
                       ("list_tables", {"catalog": "a", "schema": "b"}), ("get_relationships", {"table": "a.b.c"}),
                       ("list_concepts", {}), ("mining_suggestions", {}), ("mine_plan", {}), ("usage", {})):
        assert "connect a profile in the app first" in a.fails(name, **args), name


def test_search_tables_uses_the_warehouse_by_default_and_the_cache_on_request(agent):
    out = agent.ok("search_tables", q="order")
    assert "demo.sales.orders" in out and "information_schema" in out
    cached = agent.ok("search_tables", q="order", scope="cache")
    assert "tables already browsed" in cached
    assert "demo.sales.orders" not in cached  # nothing browsed yet
    agent.ok("describe_table", name="demo.sales.orders")
    assert "demo.sales.orders" in agent.ok("search_tables", q="order", scope="cache")
    assert "more; narrow" in agent.ok("search_tables", q="e", limit=1)


def test_describe_table_is_compact_and_has_json_on_request(agent):
    out = agent.ok("describe_table", name="demo.sales.orders")
    assert out.startswith("demo.sales.orders (")
    assert "order_id bigint" in out and "Order total in dollars" in out
    assert "FK (customer_id) -> demo.sales.customers" in out
    assert len(out) < 3000
    full = json.loads(agent.ok("describe_table", name="demo.sales.orders", format="json"))
    assert full["data"]["full_name"] == "demo.sales.orders" and len(json.dumps(full)) > len(out)
    assert "not a full table name" in agent.fails("describe_table", name="orders")


def test_describe_table_lists_the_tags_of_the_table_and_its_columns(agent):
    out = agent.ok("describe_table", name="demo.sales.orders")
    assert "tags:\n  table: certified, domain=sales, system.certification_status=certified" in out
    assert "  discount_pct: system.certification_status=deprecated" in out
    out = agent.ok("describe_table", name="demo.sales.customers")
    assert "  email: pii=email" in out and "  name: pii=name" in out
    assert "tags: none" in agent.ok("describe_table", name="demo.metrics.wide_metrics")


def test_describe_table_reads_tags_once_then_from_the_cache_until_refresh(agent, connected, tmp_path):
    def tag_queries():
        calls = (tmp_path / "logs" / "calls.jsonl").read_text(encoding="utf-8").splitlines()
        return sum("table_tags" in c for c in calls)
    agent.ok("describe_table", name="demo.sales.orders")
    assert tag_queries() == 1
    connected.post("/api/warehouse", json={"id": None})  # a cached copy needs no warehouse
    assert "domain=sales" in agent.ok("describe_table", name="demo.sales.orders")
    assert tag_queries() == 1
    assert "tags: select a warehouse to read tags" in agent.ok("describe_table", name="demo.sales.orders", refresh=True)
    connected.post("/api/warehouse", json={"id": "demo-wh-1"})
    assert "domain=sales" in agent.ok("describe_table", name="demo.sales.orders", refresh=True)
    assert tag_queries() == 2


def test_describe_table_without_a_warehouse_says_to_select_one(agent, connected):
    connected.post("/api/warehouse", json={"id": None})
    out = agent.ok("describe_table", name="demo.sales.customers")
    assert "tags: select a warehouse to read tags" in out and "columns:" in out


def test_describe_table_cuts_a_definition_and_says_so(agent):
    short = agent.ok("describe_table", name="demo.sales.sales_metrics")
    assert "view definition: version: 1.1" in short and "(cut at" not in short
    cut = agent.ok("describe_table", name="demo.sales.sales_metrics", definition_chars=60)
    assert "... (cut at 60 of " in cut and "raise definition_chars" in cut
    assert "at most 20000" in agent.fails("describe_table", name="demo.sales.sales_metrics", definition_chars=20001)


def test_find_by_tag_lists_tables_and_columns(agent, connected):
    out = agent.ok("find_by_tag", tag_name="pii")
    assert out.splitlines()[0] == "2 hit(s) for tag pii"
    assert "column demo.sales.customers#email  pii=email" in out and "column demo.sales.customers#name  pii=name" in out
    by_value = agent.ok("find_by_tag", tag_name="domain", tag_value="sales", catalog="demo")
    assert by_value.splitlines()[0] == "2 hit(s) for tag domain=sales in demo" and "table demo.sales.orders" in by_value
    assert "0 hit(s)" in agent.ok("find_by_tag", tag_name="domain", catalog="other")
    cert = agent.ok("find_by_tag", tag_name="system.certification_status", tag_value="deprecated")
    assert "demo.sales.v_daily_revenue" in cert and "demo.sales.orders#discount_pct" in cert
    assert "more than 1" in agent.ok("find_by_tag", tag_name="system.certification_status", limit=1)
    rows = json.loads(agent.ok("find_by_tag", tag_name="pii", format="json"))["rows"]
    assert rows[0] == {"scope": "column", "table": "demo.sales.customers", "column": "email", "tag_name": "pii", "tag_value": "email"}
    connected.post("/api/warehouse", json={"id": None})
    assert "No SQL warehouse is selected" in agent.fails("find_by_tag", tag_name="pii")


def test_find_by_tag_needs_a_connection(offline_agent):
    assert "connect a profile in the app first" in offline_agent.fails("find_by_tag", tag_name="pii")


def test_list_tables_marks_certification_from_the_cache_and_says_when_it_is_missing(agent, connected):
    before = agent.ok("list_tables", catalog="demo", schema="sales")
    assert "certification cache not loaded" in before.splitlines()[0] and "MANAGED [certified]" not in before
    assert connected.post("/api/certification/refresh", json={}).status_code == 200
    after = agent.ok("list_tables", catalog="demo", schema="sales")
    assert "certification cache" not in after
    assert "orders MANAGED [certified]" in after and "v_daily_revenue VIEW [deprecated]" in after


def test_list_schemas_and_tables(agent):
    assert "demo" in agent.ok("list_schemas") and "samples" in agent.ok("list_schemas")
    out = agent.ok("list_schemas", catalog="demo")
    assert out.splitlines()[0] == "3 schemas of demo" and "sales" in out
    tables = agent.ok("list_tables", catalog="demo", schema="sales")
    assert "orders MANAGED" in tables and "v_daily_revenue VIEW" in tables
    assert "more" in agent.ok("list_tables", catalog="demo", schema="sales", limit=1)


def test_get_relationships_lists_derived_edges_and_json_on_request(agent):
    out = agent.ok("get_relationships", table="demo.sales.orders")
    assert "edge(s) at demo.sales.orders (table level)" in out
    assert "fk:" in out and "demo.sales.customers" in out and "derived" in out
    data = json.loads(agent.ok("get_relationships", table="demo.sales.orders", format="json"))
    assert data["edges"] and data["table"] == "demo.sales.orders"
    col = agent.ok("get_relationships", table="demo.sales.orders", level="column")
    assert "column level" in col


def test_add_relationship_and_set_its_status_and_note(agent):
    out = agent.ok("add_relationship", source={"table": "demo.sales.orders", "column": "status"},
                   target={"table": "demo.sales.customers"}, note="by hand")
    assert out.startswith("created: e_") and "manual accepted" in out
    again = agent.ok("add_relationship", source={"table": "demo.sales.orders", "column": "status"}, target={"table": "demo.sales.customers"})
    assert again.startswith("already existed")
    rid = out.split()[1]
    rejected = agent.ok("set_relationship_status", id=rid, status="rejected", note="wrong")
    assert "rejected" in rejected and "note='wrong'" in rejected
    assert "give a status, a note, or both" in agent.fails("set_relationship_status", id=rid)
    derived = next(x.split()[0] for x in agent.ok("get_relationships", table="demo.sales.orders").splitlines() if x.startswith("fk:"))
    assert "note='checked'" in agent.ok("set_relationship_status", id=derived, note="checked")
    assert "derived edges only take a note" in agent.fails("set_relationship_status", id=derived, status="accepted")
    assert "cannot connect an endpoint to itself" in agent.fails("add_relationship", source={"table": "demo.sales.orders"}, target={"table": "demo.sales.orders"})


def test_a_concept_cannot_be_an_endpoint_of_a_relationship(agent):
    err = agent.fails("add_relationship", source={"table": "concept:7f0c2d3e-1111-4222-8333-444455556666"}, target={"table": "demo.sales.orders"})
    assert "a concept is linked through /api/concepts" in err


def test_mine_plan_shows_the_sql_and_mine_run_needs_confirm(agent):
    plan = agent.ok("mine_plan", window_days=7)
    assert "system.query.history" in plan and "system.access.table_lineage" in plan and "warehouse demo-wh-1" in plan
    assert "ends one hour before now on purpose" in plan and "Query history arrives late" in plan
    assert "confirm" in agent.fails("mine_run")
    assert "must be True" in agent.fails("mine_run", confirm=False)
    assert "mining: idle" in agent.ok("status")


def test_mine_run_then_suggestions_and_usage(agent):
    out = agent.ok("mine_run", confirm=True, window_days=30)
    assert out.startswith("mining succeeded") and "join pairs" in out
    assert "newest hour is left for the next run" in out
    sug = agent.ok("mining_suggestions", limit=3)
    assert "proposed suggestion(s)" in sug and "join_mined proposed" in sug and "runs=" in sug
    assert len(sug.splitlines()) <= 4 + 1
    by_table = agent.ok("mining_suggestions", table="demo.sales.orders", format="json")
    assert json.loads(by_table)["counts"]["proposed"] > 0
    use = agent.ok("usage", limit=3)
    assert "tables:" in use and "pairs read together:" in use and "runs=" in use
    first = sug.splitlines()[1].split()[0]
    assert "accepted" in agent.ok("set_relationship_status", id=first, status="accepted")
    assert "accepted suggestion(s)" in agent.ok("mining_suggestions", status="accepted")


def test_mine_run_with_no_warehouse_says_so(agent, connected):
    connected.post("/api/warehouse", json={"id": None})
    assert "pick a SQL warehouse" in agent.fails("mine_run", confirm=True)


def test_usage_before_any_run(agent):
    assert agent.ok("usage").startswith("No usage yet")


def test_concepts_create_update_link_find_and_unlink(agent):
    made = agent.ok("create_concept", name="Customer", definition="Someone who buys.", synonyms=["client"], domain="Sales")
    assert made.startswith("created ") and "[draft]" in made and "synonyms: client" in made
    cid = made.split()[1]
    assert 'a concept named "customer" already exists' in agent.fails("create_concept", name="customer")
    upd = agent.ok("update_concept", id=cid, status="reviewed", tags=["core"])
    assert "[reviewed]" in upd and "tags: core" in upd
    assert "give at least one field" in agent.fails("update_concept", id=cid)
    link = agent.ok("link_concept", id=cid, target={"table": "demo.sales.customers"}, relation="defines")
    assert link.startswith("linked: ") and "defines -> demo.sales.customers" in link
    got = agent.ok("get_concept", id=cid)
    assert "link e_" in got and "defines -> demo.sales.customers" in got
    assert "relation" in agent.fails("link_concept", id=cid, target={"table": "demo.sales.customers"}, relation="is_a")
    lid = next(x.split()[1] for x in got.splitlines() if x.startswith("link "))
    listing = agent.ok("list_concepts", q="client")
    assert "1 concept(s)" in listing and "Customer" in listing and "links=1" in listing
    assert json.loads(agent.ok("list_concepts", format="json"))["concepts"][0]["name"] == "Customer"
    agent.ok("describe_table", name="demo.sales.customers")  # the cache now knows the table
    cand = agent.ok("find_candidates", id=cid)
    assert "terms: Customer, client" in cand and "demo.sales" in cand
    assert agent.ok("unlink_concept", id=cid, link_id=lid) == f"removed link {lid}"
    assert "links=0" in agent.ok("list_concepts")
    assert agent.fails("get_concept", id="not-a-uuid")


def test_concepts_can_link_to_other_concepts(agent):
    a = agent.ok("create_concept", name="Order").split()[1]
    b = agent.ok("create_concept", name="Sale").split()[1]
    assert "is_a" in agent.ok("link_concept", id=b, target={"table": f"concept:{a}"}, relation="is_a")
    assert "incoming e_" in agent.ok("get_concept", id=a)
