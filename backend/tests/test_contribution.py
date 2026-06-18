from __future__ import annotations

import sqlite3

from ccfr.analysis import contribution as contrib


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
