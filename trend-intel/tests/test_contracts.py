"""Contract fixtures validate against the published schema (§13, §20 CI)."""
import json
import os

from trendintel.schema import validate_schema

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIX = os.path.join(ROOT, "contracts", "fixtures")


def _load(name):
    with open(os.path.join(FIX, name), "r", encoding="utf-8") as fh:
        return json.load(fh)


def test_canonical_brief_fixture_is_valid():
    """§6 JSON is the canonical positive fixture."""
    assert validate_schema(_load("brief.v1.json")) == []


def test_unknown_field_rejected():
    brief = _load("brief.v1.json")
    brief["unexpected_field"] = "x"
    assert validate_schema(brief) != []  # closed object


def test_bad_market_rejected():
    brief = _load("brief.v1.json")
    brief["market"] = "CAN"  # must be 2 upper-case letters
    assert validate_schema(brief) != []


def test_missing_required_rejected():
    brief = _load("brief.v1.json")
    del brief["opportunity_score"]
    assert validate_schema(brief) != []
