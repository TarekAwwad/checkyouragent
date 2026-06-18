from __future__ import annotations

import datetime
import json
import sqlite3

from ccfr.analysis import contribution as contrib
from ccfr.ingest import import_export
from ccfr.storage import init_db
from tests.fixtures import sanitized_export


def test_bucket_model_known_and_unknown():
    assert contrib.bucket_model("claude-opus-4-8") == "claude-opus-4-8"
    # Dated suffix folds to the family id.
    assert contrib.bucket_model("claude-haiku-4-5-20251001") == "claude-haiku-4-5"
    # Arbitrary / proxy strings never pass through.
    assert contrib.bucket_model("SECRET_MODEL_zzz") == "other"
    assert contrib.bucket_model(None) == "unknown"


def test_bucket_agent_type_known_and_custom():
    assert contrib.bucket_agent_type("general-purpose") == "general-purpose"
    assert contrib.bucket_agent_type("acme-deploy-bot") == "custom"
    assert contrib.bucket_agent_type(None) == "custom"


def test_call_symbol_buckets_mcp_and_unknown_tools():
    assert contrib.call_symbol("Read", None) == "CALL:inspect:Read"
    assert contrib.call_symbol("Edit", None) == "CALL:write:Edit"
    assert contrib.call_symbol("Bash", "git push --force") == "CALL:Bash:git"
    assert contrib.call_symbol("Agent", None) == "CALL:Agent"
    # MCP server names are user-configured free text -> collapsed.
    assert contrib.call_symbol("mcp__SECRETSERVER__deploy", None) == "CALL:mcp"
    # Any other unrecognized tool name -> generic.
    assert contrib.call_symbol("SomePrivateTool", None) == "CALL:other"


def test_result_symbol_is_closed_enum():
    assert contrib.result_symbol(False, "anything") == "RESULT:ok"
    assert contrib.result_symbol(True, "Permission to use Bash has been denied") == \
        "RESULT:error:permission_denied"


def _bundle_from_sanitized(tmp_path):
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    import_export(conn, sanitized_export(tmp_path))
    return contrib.build_contribution(
        conn,
        salt="00ff" * 16,
        contributor_id="11111111-1111-1111-1111-111111111111",
        app_version="0.1.0",
        generated_on=datetime.date(2026, 6, 18),
    )


def test_bundle_aggregates_sessions_with_hashed_ids(tmp_path):
    bundle = _bundle_from_sanitized(tmp_path)
    data = bundle.to_dict()

    assert data["schema_version"] == 1
    assert data["contributor_id"] == "11111111-1111-1111-1111-111111111111"
    assert data["generated_at"] == "2026-06-18"  # date-only
    assert len(data["sessions"]) == 3

    for session in data["sessions"]:
        # sid is a salted sha256 hex, never the raw uuid.
        assert len(session["sid"]) == 64
        int(session["sid"], 16)  # hex-parseable
        # date-only, no intra-day time.
        assert "T" not in session["first_date"]
        # models are bucketed to the closed vocabulary.
        for model in session["models"]:
            assert model in contrib.KNOWN_MODELS or model == "other"


def test_bundle_token_and_stat_fidelity(tmp_path):
    bundle = _bundle_from_sanitized(tmp_path)
    data = bundle.to_dict()
    totals = {"input": 0, "output": 0}
    for session in data["sessions"]:
        totals["input"] += session["tokens"]["input"]
        totals["output"] += session["tokens"]["output"]
        # stats block carries the structural counts we want.
        assert set(session["stats"]) == {
            "turns", "tool_calls", "subagents", "errors", "system",
            "loops", "max_repeat", "persisted_outputs",
        }
    # The sanitized fixture has non-zero token spend.
    assert totals["input"] > 0 and totals["output"] > 0


def test_bundle_excludes_paths_titles_branches(tmp_path):
    bundle = _bundle_from_sanitized(tmp_path)
    blob = json.dumps(bundle.to_dict())
    # cwd / paths from the fixture must not appear.
    assert "/workspace/alpha" not in blob
    assert "/workspace/beta" not in blob
    assert "importer.py" not in blob  # tool-input file path
