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


def test_sanitize_symbol_tool_calls():
    # Shell calls with valid command family pass through unchanged.
    assert contrib.sanitize_symbol("CALL:Bash:git", "tool_call") == "CALL:Bash:git"
    # Shell calls with unknown family bucket to :other.
    assert contrib.sanitize_symbol("CALL:Bash:weirdfam", "tool_call") == "CALL:Bash:other"
    # Inspect tools pass through unchanged.
    assert contrib.sanitize_symbol("CALL:inspect:Read", "tool_call") == "CALL:inspect:Read"
    # Write tools pass through unchanged.
    assert contrib.sanitize_symbol("CALL:write:Edit", "tool_call") == "CALL:write:Edit"
    # Agent call passes through unchanged.
    assert contrib.sanitize_symbol("CALL:Agent", "tool_call") == "CALL:Agent"
    # Passthrough tools pass through unchanged.
    assert contrib.sanitize_symbol("CALL:WebFetch", "tool_call") == "CALL:WebFetch"
    # MCP tool names (user-configured free text) collapse to CALL:mcp.
    assert contrib.sanitize_symbol("CALL:mcp__SECRETSERVER__deploy", "tool_call") == "CALL:mcp"
    # Any other unrecognised tool name buckets to CALL:other.
    assert contrib.sanitize_symbol("CALL:SomePrivateTool", "tool_call") == "CALL:other"


def test_sanitize_symbol_tool_results():
    # Successful result passes through unchanged.
    assert contrib.sanitize_symbol("RESULT:ok", "tool_result") == "RESULT:ok"
    # Known error class passes through unchanged.
    assert contrib.sanitize_symbol("RESULT:error:permission_denied", "tool_result") == \
        "RESULT:error:permission_denied"
    # Unknown error class buckets to :other (never echoes free-text error class).
    assert contrib.sanitize_symbol("RESULT:error:weird", "tool_result") == "RESULT:error:other"


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


def _export_with_sentinels(tmp_path):
    """A one-session export whose content fields carry unique sentinels."""
    root = tmp_path / "sentinel-export"
    project = root / "d--Secret"
    sid = "44444444-4444-4444-4444-444444444444"
    project.mkdir(parents=True)
    rows = [
        {"type": "system", "uuid": "sys", "timestamp": "2026-02-01T08:00:00Z",
         "cwd": "/Users/real/secret/path", "version": "9.9.9",
         "entrypoint": "claude", "gitBranch": "feature/SECRET_BRANCH"},
        {"type": "user", "uuid": "u1", "timestamp": "2026-02-01T08:00:01Z",
         "message": {"role": "user", "content": "SECRET_PROMPT_abc do the thing"}},
        {"type": "assistant", "uuid": "a1", "parentUuid": "u1",
         "timestamp": "2026-02-01T08:00:02Z",
         "message": {"id": "m1", "role": "assistant", "model": "SECRET_MODEL_zzz",
                     "stop_reason": "tool_use",
                     "content": [
                        {"type": "tool_use", "id": "t1", "name": "Bash",
                         "input": {"command": "git push --force SECRET_TOKEN_xyz"}},
                        {"type": "tool_use", "id": "t2", "name": "mcp__SECRETSERVER__deploy",
                         "input": {"target": "/Users/real/secret/path"}},
                     ],
                     "usage": {"input_tokens": 10, "output_tokens": 5}}},
        {"type": "user", "uuid": "u2", "parentUuid": "a1",
         "timestamp": "2026-02-01T08:00:03Z",
         "message": {"role": "user", "content": [
             {"type": "tool_result", "tool_use_id": "t1", "is_error": True,
              "content": "Permission denied SECRET_OUTPUT_qqq"},
             {"type": "tool_result", "tool_use_id": "t2",
              "content": "deployed SECRET_OUTPUT_rrr"}]}},
    ]
    (project / f"{sid}.jsonl").write_text(
        "\n".join(json.dumps(r) for r in rows), encoding="utf-8")
    return root


SENTINELS = [
    "SECRET_PROMPT_abc", "SECRET_TOKEN_xyz", "SECRET_OUTPUT_qqq", "SECRET_OUTPUT_rrr",
    "SECRET_MODEL_zzz", "mcp__SECRETSERVER__deploy", "/Users/real/secret/path",
    "feature/SECRET_BRANCH", "9.9.9",
]


def _allowed_syms():
    families = {"empty", "test", "lint_typecheck", "build", "git", "deps", "delete",
                "network", "script", "search", "list", "other"}
    error_classes = {"permission_denied", "user_rejected", "edit_without_read",
                     "file_changed", "validation", "parallel_cancel", "timeout",
                     "missing_module", "missing_command", "git", "test_failure",
                     "exit2", "exit1", "unknown", "other"}
    allowed = {"CALL:Agent", "CALL:mcp", "CALL:other", "RESULT:ok", "RESULT:other"}
    allowed |= {f"CALL:{n}" for n in contrib.PASSTHROUGH_TOOLS}
    allowed |= {f"CALL:inspect:{n}" for n in contrib.INSPECT_TOOLS}
    allowed |= {f"CALL:write:{n}" for n in contrib.WRITE_TOOLS}
    allowed |= {f"CALL:{s}:{f}" for s in contrib.SHELL_TOOLS for f in families}
    allowed |= {f"RESULT:error:{c}" for c in error_classes}
    return allowed


def test_bundle_never_leaks_sentinels(tmp_path):
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    import_export(conn, _export_with_sentinels(tmp_path))
    bundle = contrib.build_contribution(
        conn, salt="abcd" * 16, contributor_id="cid",
        app_version="0.1.0", generated_on=datetime.date(2026, 6, 18))
    blob = json.dumps(bundle.to_dict())
    for sentinel in SENTINELS:
        assert sentinel not in blob, f"leaked sentinel: {sentinel}"


def test_bundle_sequence_is_closed_vocabulary(tmp_path):
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    import_export(conn, _export_with_sentinels(tmp_path))
    bundle = contrib.build_contribution(
        conn, salt="abcd" * 16, contributor_id="cid",
        app_version="0.1.0", generated_on=datetime.date(2026, 6, 18))
    allowed = _allowed_syms()
    steps = [step for s in bundle.to_dict()["sessions"] for step in s["sequence"]]
    assert steps, "expected a non-empty sequence"
    for step in steps:
        assert step["fam"] in {"tool_call", "tool_result"}
        assert step["sym"] in allowed, f"unexpected sym: {step['sym']}"
        assert isinstance(step["dt_s"], int) and step["dt_s"] >= 0
    # The bucketed mcp call must be present (proves the mcp__ name was collapsed).
    assert any(step["sym"] == "CALL:mcp" for step in steps)


def test_bundle_manifest_summarizes_counts_and_exclusions(tmp_path):
    bundle = _bundle_from_sanitized(tmp_path)
    manifest = contrib.bundle_manifest(bundle)
    assert manifest["session_count"] == 3
    assert manifest["sequence_step_count"] == sum(
        len(s["sequence"]) for s in bundle.to_dict()["sessions"])
    # The excluded list names content categories in plain language.
    joined = " ".join(manifest["excluded"]).lower()
    assert "prompt" in joined and "file content" in joined
    # The honesty caveat is present and non-empty.
    assert "fingerprint" in manifest["fingerprint_caveat"].lower()
