from __future__ import annotations

import sqlite3
from pathlib import Path

from ccfr.analysis.risk_patterns import (
    EventFeatures,
    Feature,
    _build_slices,
    _command_family,
    _error_class,
    _mine_patterns,
    rebuild_risk_patterns,
)
from ccfr.ingest import import_export
from ccfr.storage import init_db
from tests.fixtures import sanitized_export


def test_feature_classifiers_cover_risky_tool_shapes() -> None:
    assert _command_family("uv run pytest tests/unit") == "test"
    assert _command_family("uv run ruff check .") == "lint_typecheck"
    assert _command_family("git status --short") == "git"
    assert _command_family("python scripts/check.py") == "script"

    assert _error_class("Permission to use Bash has been denied") == "permission_denied"
    assert _error_class("Denied by user") == "user_rejected"
    assert _error_class("<tool_use_error>File has not been read yet</tool_use_error>") == "edit_without_read"
    assert _error_class("File has been modified since read") == "file_changed"
    assert _error_class("ModuleNotFoundError: No module named x") == "missing_module"
    assert _error_class("Cancelled: parallel tool call Bash(...) errored") == "parallel_cancel"


def test_sequence_slicing_builds_session_sidechain_and_turn_slices() -> None:
    events = [
        EventFeatures(
            event_id=1,
            session_id=7,
            timestamp="2026-01-01T00:00:00Z",
            is_sidechain=False,
            agent_id=None,
            role="user",
            input_tokens=1,
            output_tokens=0,
            features=[Feature(1, "TEXT:user", "text")],
        ),
        EventFeatures(
            event_id=2,
            session_id=7,
            timestamp="2026-01-01T00:00:03Z",
            is_sidechain=False,
            agent_id=None,
            role="assistant",
            input_tokens=1,
            output_tokens=2,
            features=[Feature(2, "CALL:Bash:test", "tool_call")],
        ),
        EventFeatures(
            event_id=3,
            session_id=7,
            timestamp="2026-01-01T00:00:04Z",
            is_sidechain=False,
            agent_id=None,
            role="user",
            input_tokens=1,
            output_tokens=0,
            features=[Feature(3, "RESULT:error:exit1", "tool_result")],
        ),
        EventFeatures(
            event_id=4,
            session_id=7,
            timestamp="2026-01-01T00:00:05Z",
            is_sidechain=True,
            agent_id="agent-a",
            role="assistant",
            input_tokens=1,
            output_tokens=1,
            features=[Feature(4, "RESULT:error:missing_module", "tool_result")],
        ),
    ]

    slices = _build_slices({7: events})
    by_kind = {(item.kind, item.lane): item for item in slices}

    assert ("session_main", "main") in by_kind
    assert ("sidechain", "agent-a") in by_kind
    assert sum(1 for item in slices if item.kind == "turn") == 2
    assert by_kind[("session_main", "main")].outcome == "error"


def test_ngram_mining_scores_and_classifies_positive_patterns() -> None:
    risky = EventFeatures(
        event_id=1,
        session_id=1,
        timestamp=None,
        is_sidechain=False,
        agent_id=None,
        role=None,
        input_tokens=0,
        output_tokens=0,
        features=[
            Feature(1, "CALL:Bash:test", "tool_call"),
            Feature(1, "RESULT:error:exit1", "tool_result"),
            Feature(1, "CALL:write:Edit", "tool_call"),
        ],
    )
    clean = EventFeatures(
        event_id=2,
        session_id=2,
        timestamp=None,
        is_sidechain=False,
        agent_id=None,
        role=None,
        input_tokens=0,
        output_tokens=0,
        features=[
            Feature(2, "CALL:Bash:test", "tool_call"),
            Feature(2, "RESULT:ok", "tool_result"),
        ],
    )
    slices = _build_slices({1: [risky], 2: [clean]})

    patterns, occurrences = _mine_patterns(slices)
    failed = [
        pattern for pattern in patterns
        if pattern.category == "failed_verification_repair_loop"
    ]

    assert failed
    assert failed[0].positive_support >= 1
    assert failed[0].lift >= 1
    assert occurrences[(failed[0].kind, failed[0].pattern)]


def test_import_populates_risk_pattern_tables_and_findings(tmp_path: Path) -> None:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    import_export(conn, sanitized_export(tmp_path))

    counts = conn.execute(
        """
        SELECT
            (SELECT COUNT(*) FROM event_features) AS features,
            (SELECT COUNT(*) FROM sequence_slices) AS slices,
            (SELECT COUNT(*) FROM sequence_patterns) AS patterns,
            (SELECT COUNT(*) FROM risk_findings) AS findings
        """
    ).fetchone()

    assert counts["features"] > 0
    assert counts["slices"] > 0
    assert counts["patterns"] > 0
    assert counts["findings"] > 0


def test_rebuild_risk_patterns_clears_stale_rows() -> None:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    rebuild_risk_patterns(conn)

    assert conn.execute("SELECT COUNT(*) FROM risk_findings").fetchone()[0] == 0
