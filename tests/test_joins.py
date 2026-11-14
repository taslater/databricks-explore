"""sqltools.join_pairs: which column pairs a statement joins on, through aliases, CTEs and subqueries."""
import pytest

from databricks_explore.sqltools import JoinPair, join_pairs

O, C, I, P, R = ("demo.sales.orders", "demo.sales.customers", "demo.sales.order_items", "demo.sales.products",
                 "demo.sales.returns")


def pairs(sql, **kw):
    """(table, column, table, column, type) tuples, already in sorted order."""
    return [tuple(p) for p in join_pairs(sql, **kw)]


def keys(sql, **kw):
    """The same without the join type, as a set, for tests about resolution rather than join kinds."""
    return {tuple(p)[:4] for p in join_pairs(sql, **kw)}


# ---------- ON equalities ----------

def test_simple_on_with_aliases():
    sql = "SELECT * FROM demo.sales.orders o JOIN demo.sales.customers c ON o.customer_id = c.customer_id"
    assert pairs(sql) == [(C, "customer_id", O, "customer_id", "inner")]


def test_pair_is_the_same_whichever_way_round_it_is_written():
    a = "SELECT 1 FROM demo.sales.orders o JOIN demo.sales.customers c ON o.customer_id = c.customer_id"
    b = "SELECT 1 FROM demo.sales.customers c JOIN demo.sales.orders o ON c.customer_id = o.customer_id"
    assert pairs(a) == pairs(b)


def test_composite_key_with_extra_filters_in_the_on_clause():
    sql = """SELECT * FROM a.b.x x JOIN a.b.y y
             ON x.k1 = y.k1 AND (x.k2 = y.k2) AND y.flag = 1 AND x.d > y.d AND x.name = 'a=b'"""
    assert keys(sql) == {("a.b.x", "k1", "a.b.y", "k1"), ("a.b.x", "k2", "a.b.y", "k2")}


@pytest.mark.parametrize("word, expected", [
    ("LEFT JOIN", "left"), ("LEFT OUTER JOIN", "left"), ("RIGHT JOIN", "right"), ("FULL OUTER JOIN", "full"),
    ("INNER JOIN", "inner"), ("JOIN", "inner"), ("LEFT SEMI JOIN", "semi"), ("LEFT ANTI JOIN", "anti"),
])
def test_join_types(word, expected):
    got = pairs(f"SELECT * FROM a.b.x x {word} a.b.y y ON x.id = y.xid")
    assert got == [("a.b.x", "id", "a.b.y", "xid", expected)]


def test_names_and_columns_are_lowercased_and_quotes_removed():
    sql = "SELECT * FROM `Demo`.Sales.Orders AS O JOIN `demo`.`sales`.`Customers` C ON O.`Customer_ID` = C.CUSTOMER_id"
    assert keys(sql) == {(C, "customer_id", O, "customer_id")}


def test_null_safe_equality_and_casts_count():
    sql = "SELECT * FROM a.b.x x JOIN a.b.y y ON CAST(x.id AS BIGINT) <=> y.id"
    assert keys(sql) == {("a.b.x", "id", "a.b.y", "id")}


def test_comments_whitespace_and_trailing_semicolon():
    sql = """-- who ordered what
    SELECT /* hint */ *
    FROM   demo.sales.orders   o
    JOIN   demo.sales.customers c   -- customers
      ON   o.customer_id
         = c.customer_id ;"""
    assert keys(sql) == {(C, "customer_id", O, "customer_id")}


def test_named_parameters_do_not_break_parsing():
    sql = "SELECT * FROM a.b.x x JOIN a.b.y y ON x.id = y.xid WHERE x.day >= :start AND y.k = :key"
    assert keys(sql) == {("a.b.x", "id", "a.b.y", "xid")}


# ---------- what is dropped rather than guessed ----------

def test_or_conditions_are_dropped():
    assert pairs("SELECT * FROM a.b.x x JOIN a.b.y y ON x.k = y.k OR x.j = y.j") == []


def test_a_function_of_a_column_is_dropped_but_a_cast_is_not():
    assert pairs("SELECT * FROM a.b.x x JOIN a.b.y y ON upper(x.k) = y.k") == []
    assert pairs("SELECT * FROM a.b.x x JOIN a.b.y y ON x.k + 1 = y.k") == []
    assert pairs("SELECT * FROM a.b.x x JOIN a.b.y y ON x.k = coalesce(y.k, 0)") == []


def test_unqualified_columns_with_two_tables_in_scope_are_dropped():
    assert pairs("SELECT * FROM a.b.x JOIN a.b.y ON x_id = y_id") == []


def test_unqualified_column_with_one_table_in_scope_still_needs_two_sides():
    assert pairs("SELECT * FROM a.b.x WHERE a = b") == []


def test_an_alias_that_is_not_a_source_is_dropped():
    assert pairs("SELECT * FROM a.b.x x JOIN a.b.y y ON x.id = z.id") == []


def test_a_union_branch_has_no_single_origin():
    sql = """WITH u AS (SELECT id FROM a.b.p UNION ALL SELECT id FROM a.b.q)
             SELECT * FROM u JOIN a.b.x x ON x.pid = u.id"""
    assert pairs(sql) == []


def test_computed_projection_is_dropped_but_plain_columns_beside_it_resolve():
    sql = """WITH t AS (SELECT id + 1 AS id2, customer_id AS cid FROM a.b.o)
             SELECT * FROM t JOIN a.b.c c ON c.id = t.id2 AND c.cid = t.cid"""
    assert keys(sql) == {("a.b.c", "cid", "a.b.o", "customer_id")}


def test_natural_join_names_no_columns():
    assert pairs("SELECT * FROM a.b.x NATURAL JOIN a.b.y") == []


def test_table_valued_functions_are_not_tables():
    assert pairs("SELECT * FROM a.b.x x JOIN range(10) r ON x.id = r.id") == []


def test_same_column_of_the_same_table_is_not_a_relationship():
    assert pairs("SELECT * FROM a.b.x x JOIN a.b.x y ON x.id = y.id") == []


def test_four_part_names_are_dropped():
    assert pairs("SELECT * FROM a.b.c.d x JOIN a.b.y y ON x.id = y.id") == []


# ---------- aliases, CTEs and subqueries back to base tables ----------

def test_cte_with_renamed_column_and_a_star_cte():
    sql = """WITH o AS (SELECT order_id AS oid, customer_id FROM demo.sales.orders),
                  c AS (SELECT * FROM demo.sales.customers)
             SELECT * FROM o
             JOIN c ON o.customer_id = c.customer_id
             JOIN demo.sales.order_items i ON i.order_id = o.oid"""
    assert keys(sql) == {(C, "customer_id", O, "customer_id"), (I, "order_id", O, "order_id")}


def test_cte_chain_with_aliases_at_every_level():
    sql = """WITH a AS (SELECT t.id AS k FROM a.b.t t),
                  b AS (SELECT k AS kk FROM a),
                  c AS (SELECT kk FROM b)
             SELECT * FROM c JOIN a.b.u u ON u.t_id = c.kk"""
    assert keys(sql) == {("a.b.t", "id", "a.b.u", "t_id")}


def test_derived_table_and_nested_subqueries():
    sql = """SELECT * FROM (SELECT customer_id, sum(amount) AS s FROM demo.sales.orders GROUP BY 1) t
             JOIN (SELECT * FROM (SELECT * FROM demo.sales.customers) z) c ON c.customer_id = t.customer_id"""
    assert keys(sql) == {(C, "customer_id", O, "customer_id")}


def test_qualified_star_in_a_subquery_picks_its_own_table():
    sql = """SELECT * FROM (SELECT o.*, c.name FROM demo.sales.orders o, demo.sales.customers c) t
             JOIN demo.sales.order_items i ON i.order_id = t.order_id"""
    assert keys(sql) == {(I, "order_id", O, "order_id")}


def test_unqualified_star_over_two_tables_is_ambiguous():
    sql = """SELECT * FROM (SELECT * FROM demo.sales.orders o, demo.sales.customers c) t
             JOIN demo.sales.order_items i ON i.order_id = t.order_id"""
    assert pairs(sql) == []


def test_cte_shadows_a_table_of_the_same_name():
    sql = """WITH orders AS (SELECT id AS oid FROM a.b.real_orders)
             SELECT * FROM orders JOIN a.b.x x ON x.oid = orders.oid"""
    assert keys(sql) == {("a.b.real_orders", "id", "a.b.x", "oid")}


def test_self_join_on_different_columns_is_kept():
    sql = "SELECT * FROM demo.sales.orders p JOIN demo.sales.orders c ON c.parent_id = p.order_id"
    assert keys(sql) == {(O, "order_id", O, "parent_id")}


def test_join_inside_a_cte_and_a_subquery_in_the_where_clause():
    sql = """WITH j AS (SELECT o.order_id FROM demo.sales.orders o JOIN demo.sales.customers c ON c.customer_id = o.customer_id)
             SELECT * FROM j JOIN demo.sales.returns r ON r.order_id = j.order_id
             WHERE r.order_id IN (SELECT i.order_id FROM demo.sales.order_items i JOIN demo.sales.products p ON p.sku = i.sku)"""
    assert keys(sql) == {(C, "customer_id", O, "customer_id"), (O, "order_id", R, "order_id"), (I, "sku", P, "sku")}


# ---------- USING ----------

def test_using_with_one_table_on_the_left():
    sql = "SELECT * FROM demo.sales.orders JOIN demo.sales.customers USING (customer_id)"
    assert pairs(sql) == [(C, "customer_id", O, "customer_id", "inner")]


def test_using_with_several_columns_and_a_left_join():
    sql = "SELECT * FROM demo.sales.order_items i LEFT JOIN demo.sales.returns r USING (order_id, line_no)"
    assert pairs(sql) == [(I, "order_id", R, "order_id", "left"), (I, "line_no", R, "line_no", "left")]


def test_using_after_a_chain_is_dropped_because_the_left_column_is_ambiguous():
    sql = """SELECT * FROM demo.sales.orders o JOIN demo.sales.customers c USING (customer_id)
             JOIN demo.sales.returns r USING (order_id)"""
    assert keys(sql) == {(C, "customer_id", O, "customer_id")}


def test_using_through_a_cte():
    sql = """WITH o AS (SELECT order_id, customer_id FROM demo.sales.orders)
             SELECT * FROM o JOIN demo.sales.returns USING (order_id)"""
    assert keys(sql) == {(O, "order_id", R, "order_id")}


# ---------- comma joins, cross joins and WHERE ----------

def test_comma_join_with_where_equalities():
    sql = """SELECT * FROM demo.sales.orders o, demo.sales.customers c, demo.sales.returns r
             WHERE o.customer_id = c.customer_id AND r.order_id = o.order_id AND o.amount > 5"""
    assert pairs(sql) == [(C, "customer_id", O, "customer_id", "implicit"), (O, "order_id", R, "order_id", "implicit")]


def test_cross_join_with_where_counts_as_implicit():
    sql = "SELECT * FROM a.b.x x CROSS JOIN a.b.y y WHERE x.id = y.xid"
    assert pairs(sql) == [("a.b.x", "id", "a.b.y", "xid", "implicit")]


def test_where_equalities_without_an_implicit_join_are_not_joins():
    assert pairs("SELECT * FROM a.b.x x JOIN a.b.y y ON x.id = y.xid WHERE x.a = y.b") == [
        ("a.b.x", "id", "a.b.y", "xid", "inner")]


def test_comma_join_with_a_cte_and_a_subquery():
    sql = """WITH big AS (SELECT customer_id FROM demo.sales.orders WHERE amount > 100)
             SELECT * FROM big b, (SELECT * FROM demo.sales.customers) c WHERE b.customer_id = c.customer_id"""
    assert keys(sql) == {(C, "customer_id", O, "customer_id")}


def test_a_literal_comparison_in_where_is_not_a_join():
    assert pairs("SELECT * FROM a.b.x x, a.b.y y WHERE x.id = 1 AND y.id = 'a'") == []


# ---------- correlated subqueries and MERGE ----------

def test_exists_correlation():
    sql = "SELECT * FROM demo.sales.orders o WHERE EXISTS (SELECT 1 FROM demo.sales.returns r WHERE r.order_id = o.order_id)"
    assert pairs(sql) == [(O, "order_id", R, "order_id", "correlated")]


def test_scalar_subquery_correlation_in_select_list():
    sql = """SELECT c.customer_id, (SELECT max(o.order_ts) FROM demo.sales.orders o WHERE o.customer_id = c.customer_id)
             FROM demo.sales.customers c"""
    assert keys(sql) == {(C, "customer_id", O, "customer_id")}


def test_merge_on_with_table_source():
    sql = """MERGE INTO demo.sales.orders t USING demo.sales.returns s ON t.order_id = s.order_id AND t.line = s.line
             WHEN MATCHED THEN UPDATE SET t.status = 'returned'"""
    assert keys(sql) == {(O, "order_id", R, "order_id"), (O, "line", R, "line")}


def test_merge_with_a_subquery_source_and_its_own_join():
    sql = """MERGE INTO demo.sales.orders t
             USING (SELECT r.order_id, c.customer_id FROM demo.sales.returns r JOIN demo.sales.customers c ON c.k = r.k) s
             ON t.order_id = s.order_id WHEN MATCHED THEN DELETE"""
    assert keys(sql) == {(O, "order_id", R, "order_id"), (C, "k", R, "k")}


# ---------- statements that write ----------

def test_insert_select_and_create_table_as_select():
    ins = "INSERT INTO a.b.out SELECT * FROM a.b.x x JOIN a.b.y y ON x.id = y.xid"
    ctas = "CREATE TABLE a.b.out AS SELECT * FROM a.b.x x JOIN a.b.y y ON x.id = y.xid"
    view = "CREATE OR REPLACE VIEW a.b.v AS SELECT * FROM a.b.x x JOIN a.b.y y ON x.id = y.xid"
    for sql in (ins, ctas, view):
        assert keys(sql) == {("a.b.x", "id", "a.b.y", "xid")}


def test_the_write_target_is_not_a_join_end():
    assert pairs("INSERT INTO a.b.out SELECT * FROM a.b.x") == []


# ---------- qualifying short names ----------

SHORT = "SELECT * FROM orders o JOIN customers c ON o.customer_id = c.customer_id"


def test_short_names_without_defaults_or_known_names_are_dropped():
    assert pairs(SHORT) == []


def test_short_names_take_the_default_catalog_and_schema():
    assert keys(SHORT, default_catalog="Demo", default_schema="Sales") == {(C, "customer_id", O, "customer_id")}


def test_two_part_names_need_only_the_default_catalog():
    sql = "SELECT * FROM sales.orders o JOIN sales.customers c ON o.customer_id = c.customer_id"
    assert pairs(sql) == []
    assert keys(sql, default_catalog="demo") == {(C, "customer_id", O, "customer_id")}


def test_known_names_qualify_short_names_when_exactly_one_fits():
    assert keys(SHORT, known=[O, C, I]) == {(C, "customer_id", O, "customer_id")}
    assert keys("SELECT * FROM sales.orders o JOIN sales.customers c ON o.customer_id = c.customer_id",
                known=[O, C]) == {(C, "customer_id", O, "customer_id")}


def test_ambiguous_known_names_are_dropped_unless_a_default_decides():
    known = ["demo.sales.orders", "demo.archive.orders", C]
    assert pairs(SHORT, known=known) == []
    assert keys(SHORT, known=known, default_catalog="demo", default_schema="archive") == {
        ("demo.archive.orders", "customer_id", C, "customer_id")}


def test_a_default_that_is_also_known_wins_over_other_known_names():
    known = ["demo.sales.orders", "demo.archive.orders", C]
    assert keys(SHORT, known=known, default_catalog="demo", default_schema="sales") == {
        (C, "customer_id", O, "customer_id")}


def test_a_default_that_is_not_known_gives_way_to_the_one_known_name():
    # USE had pointed somewhere else than the defaults say; the statement's lineage settles it.
    assert keys(SHORT, known=[O, C], default_catalog="other", default_schema="x") == {
        (C, "customer_id", O, "customer_id")}


# ---------- statements and failures ----------

def test_several_statements_in_one_text_and_duplicate_pairs_collapse():
    sql = """SELECT * FROM a.b.x x JOIN a.b.y y ON x.id = y.xid;
             SELECT * FROM a.b.y y2 JOIN a.b.x x2 ON y2.xid = x2.id;
             SELECT * FROM a.b.p p JOIN a.b.q q ON p.k = q.k"""
    assert keys(sql) == {("a.b.x", "id", "a.b.y", "xid"), ("a.b.p", "k", "a.b.q", "k")}


def test_a_statement_without_joins_gives_an_empty_list():
    assert join_pairs("SELECT 1") == []
    assert join_pairs("SHOW TABLES") == []
    assert join_pairs("") == []


@pytest.mark.parametrize("sql", [
    "SELECT * FROM a JOIN",
    "SELECT * FROM (SELECT * FROM a.b.x",
    "SELECT * FROM a.b.x WHERE (x.id = ",
    "SELECT 'unterminated FROM a.b.x",
])
def test_unparseable_sql_raises_value_error(sql):
    with pytest.raises(ValueError, match="cannot parse"):
        join_pairs(sql)


def test_deeply_nested_sql_is_a_parse_failure_not_a_crash():
    sql = "SELECT * FROM a.b.x x WHERE " + "(" * 3000 + "x.id = 1" + ")" * 3000
    try:
        join_pairs(sql)
    except ValueError as e:
        assert "cannot parse" in str(e)


def test_pairs_are_named_tuples():
    p = join_pairs("SELECT * FROM a.b.x x JOIN a.b.y y ON x.id = y.xid")[0]
    assert isinstance(p, JoinPair) and p.left_table == "a.b.x" and p.right_column == "xid" and p.join_type == "inner"
