"""run_sql: the read-only gate (sqlglot), the row and time caps, cancellation, and the TSV output."""
import pytest

import dbx
from mcp_helpers import agent, connected, env, offline_agent  # noqa: F401
from mcp_server import tools_data
from mcp_server.sqlguard import NotReadOnly, check_read_only


@pytest.mark.parametrize("sql", [
    "SELECT 1",
    "select * from demo.sales.orders where amount > 10;",
    "WITH a AS (SELECT 1 AS x) SELECT * FROM a",
    "SELECT 1 UNION ALL SELECT 2",
    "(SELECT 1)",
    "SELECT * FROM demo.sales.orders TIMESTAMP AS OF '2026-01-01'",
    "-- a comment\nSELECT 1",
    "DESCRIBE TABLE demo.sales.orders",
    "DESC EXTENDED demo.sales.orders",
    "DESCRIBE HISTORY demo.sales.orders",
    "SHOW TABLES IN demo.sales",
    "SHOW CREATE TABLE demo.sales.orders",
    "EXPLAIN SELECT 1",
    "EXPLAIN EXTENDED SELECT * FROM demo.sales.orders",
    "SELECT 'a;b' AS semicolon_in_a_string",
])
def test_these_are_accepted(sql):
    assert check_read_only(sql)


@pytest.mark.parametrize("sql, why", [
    ("DROP TABLE demo.sales.orders", "DROP"),
    ("DELETE FROM demo.sales.orders", "DELETE"),
    ("INSERT INTO t SELECT 1", "INSERT"),
    ("INSERT OVERWRITE t SELECT 1", "INSERT"),
    ("UPDATE t SET a = 1", "UPDATE"),
    ("MERGE INTO a USING b ON a.x = b.x WHEN MATCHED THEN DELETE", "MERGE"),
    ("CREATE TABLE x AS SELECT 1", "CREATE"),
    ("CREATE OR REPLACE VIEW v AS SELECT 1", "CREATE"),
    ("ALTER TABLE t ADD COLUMN c INT", "ALTER"),
    ("TRUNCATE TABLE t", "TRUNCATE"),
    ("GRANT SELECT ON TABLE t TO `x`", ""),
    ("SET spark.sql.shuffle.partitions = 1", "SET"),
    ("USE CATALOG demo", "USE"),
    ("OPTIMIZE demo.sales.orders", "OPTIMIZE"),
    ("COPY INTO t FROM 's3://x'", "COPY"),
    ("CALL some_procedure()", "CALL"),
    ("SELECT * INTO x FROM y", "INTO"),
    ("WITH a AS (SELECT 1) INSERT INTO t SELECT * FROM a", "INSERT"),
    ("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", ""),
    ("SELECT * FROM (DELETE FROM t RETURNING *)", ""),
    ("SELECT reflect('java.lang.System', 'exit', 0)", "reflect"),
    ("SELECT java_method('java.lang.Runtime', 'getRuntime')", "java_method"),
    ("SELECT 1; SELECT 2", "2 statements"),
    ("SELECT 1; DROP TABLE t", "2 statements"),
    ("SELECT 1;;DROP TABLE t;", ""),
    ("", "empty"),
    ("   ;  ", "empty"),
    ("this is not sql at all", ""),
    ("SELECT FROM WHERE (", ""),
])
def test_these_are_rejected(sql, why):
    with pytest.raises(NotReadOnly) as e:
        check_read_only(sql)
    assert why.lower() in str(e.value).lower()


def test_the_statement_comes_back_without_its_trailing_semicolon():
    assert check_read_only("  SELECT 1 ;  ") == "SELECT 1"


def test_run_sql_returns_types_and_tsv(agent):
    out = agent.ok("run_sql", statement="SELECT * FROM demo.sales.orders", max_rows=3)
    lines = out.splitlines()
    assert lines[0].startswith("columns: order_id bigint, customer_id bigint")
    assert lines[1].split("\t")[:2] == ["order_id", "customer_id"]
    assert len(lines) == 2 + 3 + 1 and "3 row(s) shown" in lines[-1] and "more than 3 rows" in lines[-1]
    assert all(line.count("\t") == lines[1].count("\t") for line in lines[1:-1])


def test_run_sql_cuts_cells_and_total_size(agent, monkeypatch):
    out = agent.ok("run_sql", statement="SELECT * FROM demo.sales.orders", max_rows=1000)
    assert len(out) < tools_data.TSV_CHARS + 2000
    assert "output size cap" in out.splitlines()[-1]
    assert tools_data._cell("x" * 500).endswith("...") and len(tools_data._cell("x" * 500)) == tools_data.CELL_CHARS + 3
    assert tools_data._cell("a\tb\nc") == "a b c" and tools_data._cell(None) == "NULL"


def test_run_sql_default_cap_is_100_and_the_bound_is_1000(agent):
    out = agent.ok("run_sql", statement="SELECT * FROM demo.sales.orders")
    assert "100 row(s) shown" in out
    assert "at most 1000" in agent.fails("run_sql", statement="SELECT 1", max_rows=1001)
    assert "at least 1" in agent.fails("run_sql", statement="SELECT 1", max_rows=0)


def test_run_sql_rejects_what_the_gate_rejects_and_never_reaches_the_warehouse(agent, connected, tmp_path):
    for sql in ("DROP TABLE demo.sales.orders", "SELECT 1; SELECT 2", "WITH a AS (SELECT 1) DELETE FROM t", "nonsense ((("):
        assert agent.fails("run_sql", statement=sql).startswith("Rejected:")
    assert "statement.execute" not in (tmp_path / "logs" / "calls.jsonl").read_text()


def test_a_failing_statement_reports_the_warehouse_error(agent):
    assert "TABLE_OR_VIEW_NOT_FOUND" in agent.fails("run_sql", statement="SELECT * FROM demo_error")


def test_a_slow_statement_times_out_and_is_cancelled(agent, tmp_path):
    out = agent.fails("run_sql", statement="SELECT 'demo_slow'", timeout_s=1)
    assert "Timed out after 1s and cancelled" in out
    assert "statement.cancel" in (tmp_path / "logs" / "calls.jsonl").read_text()


def test_run_sql_needs_a_connection(offline_agent):
    assert "connect a profile in the app first" in offline_agent.fails("run_sql", statement="SELECT 1")


def test_run_sql_needs_a_warehouse(agent, connected):
    connected.post("/api/warehouse", json={"id": None})
    assert "No SQL warehouse is selected" in agent.fails("run_sql", statement="SELECT 1")


def test_describe_and_show_run(agent):
    assert "columns:" in agent.ok("run_sql", statement="DESCRIBE TABLE demo.sales.orders")
    assert "columns:" in agent.ok("run_sql", statement="SHOW TABLES IN demo.sales")
