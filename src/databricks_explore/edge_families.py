"""The three edge families: what a relationship means (web/src/graph/edgeStyles.ts FAMILY_OF is the twin; tests/test_parity.py checks both).

flow: data moves from source to target. reference: a key in one table identifies a row in another. meaning: concept,
ontology and sketch links. Only flow edges set the Graph's left-to-right order."""

FAMILY_OF = {
    "lineage": "flow", "view_dep": "flow",
    "fk": "reference", "join_mined": "reference", "manual": "reference",
    "sketch": "meaning", "concept_link": "meaning", "ontology": "meaning",
}
FLOW_KINDS = tuple(k for k, f in FAMILY_OF.items() if f == "flow")


def family_of(kind):
    """The family of an edge kind (flow, reference or meaning), or None for a kind this version does not know."""
    return FAMILY_OF.get(kind)
