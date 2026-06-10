from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from ccfr.analysis import discovery
from ccfr.analysis.discovery import (
    _adjusted_z,
    _candidate_groups,
    _descriptor,
    _section,
    _wilson_lower_bound,
    discovery_analytics,
    Subject,
)
from ccfr.api.deps import get_db
from ccfr.main import create_app
from ccfr.storage import init_db


# ---------------------------------------------------------------------------
# Unit tests for Bonferroni-adjusted z helper
# ---------------------------------------------------------------------------

def test_adjusted_z_single_candidate_matches_classic_z() -> None:
    # With one candidate the Bonferroni correction is a no-op.
    # inv_cdf(1 - 0.05/1) = inv_cdf(0.95) ≈ 1.6449.
    assert abs(_adjusted_z(1) - 1.6449) < 1e-3


def test_adjusted_z_twenty_candidates() -> None:
    # inv_cdf(1 - 0.05/20) = inv_cdf(0.9975) ≈ 2.807.
    assert abs(_adjusted_z(20) - 2.807) < 1e-2


def test_adjusted_z_is_monotonically_increasing() -> None:
    assert _adjusted_z(80) > _adjusted_z(20) > _adjusted_z(1)


# ---------------------------------------------------------------------------
# End-to-end _section test: marginal subgroup excluded, strong one kept
# ---------------------------------------------------------------------------

def test_section_bonferroni_gate_excludes_marginal_keeps_strong() -> None:
    """A marginal subgroup that clears the classic z=1.6449 gate must be
    excluded once the gate is Bonferroni-adjusted for the candidates scored,
    while a strong subgroup survives.

    Population (195 subjects, 39 positive, baseline rate exactly 0.20):
      - "strong" (signal family): 20 subjects, 18 positive (rate 0.90).
        Clears the adjusted gate with a wide margin.
      - "marginal" (signal family): 25 subjects, 10 positive (rate 0.40).
        Wilson lower bound at z=1.6449 is ~0.256 (clears the 0.20 baseline by
        ~0.056); at the adjusted z for m=32 candidates it is ~0.175 (fails by
        ~0.025).
      - 30 "noise" descriptors (noise family) over 150 background subjects,
        support exactly 5 each, so every one clears min_support=5 and counts
        toward m. Eleven of them carry exactly 1 positive (rate 0.20, equal to
        baseline — never a finding) and the rest carry none. No subject mixes
        families, so no pair candidates form: m = 30 + 2 = 32 exactly.
    """
    strong_desc = _descriptor("signal", "strong", "Strong signal")
    marginal_desc = _descriptor("signal", "marginal", "Marginal signal")
    noise_descriptors = [
        _descriptor("noise", f"v{i}", f"Noise {i}") for i in range(30)
    ]

    subjects: list[Subject] = []
    for i in range(20):
        subjects.append(Subject(id=len(subjects), descriptors={strong_desc}, positive=i < 18))
    for i in range(25):
        subjects.append(Subject(id=len(subjects), descriptors={marginal_desc}, positive=i < 10))
    for noise_index, noise in enumerate(noise_descriptors):
        for member in range(5):
            subjects.append(
                Subject(
                    id=len(subjects),
                    descriptors={noise},
                    positive=noise_index < 11 and member == 0,
                )
            )

    total = len(subjects)
    positives = sum(1 for subject in subjects if subject.positive)
    baseline_rate = positives / total
    assert (total, positives) == (195, 39)
    assert baseline_rate == 0.20

    # m must match what _section scores: replicate the candidate filter
    # (require_fanout is False here, so every candidate is scored).
    candidates = _candidate_groups(subjects, min_support=5)
    m = len(candidates)
    assert m == 32

    # The marginal subgroup clears the classic gate and fails the adjusted one,
    # with comfortable margins on both sides — the test is not balanced on a
    # rounding edge.
    lb_classic = _wilson_lower_bound(10, 25, _adjusted_z(1))
    lb_adjusted = _wilson_lower_bound(10, 25, _adjusted_z(m))
    assert lb_classic > baseline_rate + 0.04
    assert lb_adjusted < baseline_rate - 0.02

    result = _section(
        key="test",
        title="Test section",
        target_label="Positives",
        description="Test",
        subjects=subjects,
        min_support=5,
    )
    result_ids = {item["id"] for item in result["results"]}

    assert strong_desc.key in result_ids, (
        f"Strong driver was incorrectly excluded. Results: {result_ids}"
    )
    assert marginal_desc.key not in result_ids, (
        f"Marginal driver survived the adjusted gate. Results: {result_ids}"
    )


def _add_session(
    conn: sqlite3.Connection,
    *,
    project_id: int,
    session_uuid: str,
    title: str,
    model: str,
    base_tokens: int,
    subagents: int,
    tool_name: str | None = None,
) -> int:
    session_id = int(conn.execute(
        """
        INSERT INTO sessions(project_id, session_id, title, first_ts, last_ts)
        VALUES (?, ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z')
        """,
        (project_id, session_uuid, title),
    ).lastrowid)
    event_id = int(conn.execute(
        """
        INSERT INTO events(session_id, source_path, line_no, type, timestamp, raw_json)
        VALUES (?, 'fixture.jsonl', 1, 'assistant', '2026-01-01T00:01:00Z', '{}')
        """,
        (session_id,),
    ).lastrowid)
    conn.execute(
        """
        INSERT INTO messages(
            event_id, role, model, input_tokens, output_tokens,
            base_input_tokens, cache_5m_tokens, cache_1h_tokens, cache_read_tokens
        )
        VALUES (?, 'assistant', ?, ?, 0, ?, 0, 0, 0)
        """,
        (event_id, model, base_tokens, base_tokens),
    )
    if tool_name:
        conn.execute(
            """
            INSERT INTO tool_calls(event_id, session_id, tool_use_id, tool_name, raw_json)
            VALUES (?, ?, ?, ?, ?)
            """,
            (event_id, session_id, f"{session_uuid}-tool", tool_name, "{}"),
        )
    conn.execute(
        """
        INSERT INTO session_stats(
            session_id, event_count, turn_count, tool_call_count, subagent_count,
            error_count, system_count, persisted_output_count, input_tokens, output_tokens,
            loop_count, max_repeat
        )
        VALUES (?, 4, 2, ?, ?, 0, 0, 0, ?, 0, 0, 0)
        """,
        (session_id, 1 if tool_name else 0, subagents, base_tokens),
    )
    return session_id


def _seed(conn: sqlite3.Connection) -> tuple[int, int]:
    import_id = int(conn.execute(
        """
        INSERT INTO imports(source_path, imported_at, file_count, status, error_count)
        VALUES ('fixture', '2026-01-01T00:00:00Z', 0, 'completed', 0)
        """
    ).lastrowid)
    alpha = int(conn.execute(
        "INSERT INTO projects(import_id, export_name, inferred_cwd) VALUES (?, 'alpha', NULL)",
        (import_id,),
    ).lastrowid)
    beta = int(conn.execute(
        "INSERT INTO projects(import_id, export_name, inferred_cwd) VALUES (?, 'beta', NULL)",
        (import_id,),
    ).lastrowid)

    # Cost signal: a dozen high-cost fanout sessions whose cost dominates the
    # top-decile band, against many cheap quiet sessions. All fanout sessions
    # share the same token count so they all tie at the 90th-percentile
    # threshold and are all marked positive — ensuring the Bonferroni-adjusted
    # Wilson gate is cleared even when scoped to the smaller alpha project.
    for index in range(12):
        _add_session(
            conn,
            project_id=alpha,
            session_uuid=f"alpha-fanout-{index}",
            title=f"Alpha fanout {index}",
            model="claude-sonnet-4-6",
            base_tokens=100_000_000,
            subagents=12,
            tool_name="Agent",
        )
    for index in range(48):
        _add_session(
            conn,
            project_id=alpha if index < 24 else beta,
            session_uuid=f"quiet-{index}",
            title=f"Quiet {index}",
            model="claude-haiku-4-5",
            base_tokens=1_000_000,
            subagents=0,
            tool_name="Read",
        )

    sessions = [row["id"] for row in conn.execute("SELECT id FROM sessions ORDER BY id").fetchall()]
    # Tool-error signal: 40 Bash test-command calls erroring 70% of the time vs
    # 40 Read calls that almost never error.
    for index in range(80):
        session_id = sessions[index % len(sessions)]
        event_id = int(conn.execute(
            """
            INSERT INTO events(session_id, source_path, line_no, type, timestamp, raw_json)
            VALUES (?, 'tools.jsonl', ?, 'assistant', '2026-01-01T00:10:00Z', '{}')
            """,
            (session_id, index + 1),
        ).lastrowid)
        is_test = index < 40
        tool_use_id = f"call-{index}"
        command = "uv run pytest tests" if is_test else ""
        raw_json = f'{{"input": {{"command": "{command}"}}}}' if is_test else "{}"
        conn.execute(
            """
            INSERT INTO tool_calls(event_id, session_id, tool_use_id, tool_name, input_preview, raw_json)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (event_id, session_id, tool_use_id, "Bash" if is_test else "Read", command, raw_json),
        )
        is_error = (is_test and index < 28) or (not is_test and index >= 78)
        conn.execute(
            """
            INSERT INTO tool_results(event_id, session_id, tool_use_id, is_error, raw_json)
            VALUES (?, ?, ?, ?, '{}')
            """,
            (event_id, session_id, tool_use_id, 1 if is_error else 0),
        )

    # Rejection signal: 40 git-activity slices rejected 70% of the time vs 40
    # inspect/read slices that are almost always clean.
    for index in range(80):
        session_id = sessions[index % len(sessions)]
        event_id = int(conn.execute(
            """
            INSERT INTO events(session_id, source_path, line_no, type, timestamp, raw_json)
            VALUES (?, 'slices.jsonl', ?, 'assistant', '2026-01-01T00:20:00Z', '{}')
            """,
            (session_id, index + 1),
        ).lastrowid)
        is_git = index < 40
        rejected = (is_git and index < 28) or (not is_git and index >= 78)
        slice_id = int(conn.execute(
            """
            INSERT INTO sequence_slices(session_id, kind, lane, start_event_id, end_event_id, outcome, length, duration_seconds)
            VALUES (?, 'turn', 'main', ?, ?, ?, 4, 60)
            """,
            (session_id, event_id, event_id, "rejected" if rejected else "clean"),
        ).lastrowid)
        symbol = "CALL:Bash:git" if is_git else "CALL:inspect:Read"
        conn.execute(
            """
            INSERT INTO event_features(event_id, session_id, sequence_slice_id, position, symbol, family, attributes_json)
            VALUES (?, ?, ?, 0, ?, 'tool_call', '{}')
            """,
            (event_id, session_id, slice_id, symbol),
        )
    conn.commit()
    return alpha, beta


@pytest.fixture()
def seeded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[sqlite3.Connection, int, int]:
    csv = tmp_path / "pricing.csv"
    csv.write_text(
        "model,base-input-tokens,5m-cache-writes,1h-cache-writes,cache-hits-&-refreshes,output-tokens\n"
        "claude-sonnet-4-6,1,1,1,1,1\n"
        "claude-haiku-4-5,1,1,1,1,1\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(discovery, "pricing_path", lambda: csv)
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    init_db(conn)
    alpha, beta = _seed(conn)
    return conn, alpha, beta


def test_discovery_returns_ranked_driver_sections(seeded: tuple[sqlite3.Connection, int, int]) -> None:
    conn, _alpha, _beta = seeded
    payload = discovery_analytics(conn, min_support=3)

    assert set(payload["sections"]) == {"cost", "fanout_cost", "tool_errors", "rejections"}
    cost = payload["sections"]["cost"]
    fanout = payload["sections"]["fanout_cost"]
    tool_errors = payload["sections"]["tool_errors"]
    rejections = payload["sections"]["rejections"]

    assert cost["available"] is True
    assert any("subagents" in result["title"] or "Uses Agent" in result["title"] for result in fanout["results"])
    assert any("Bash Test commands" in result["title"] for result in tool_errors["results"])
    assert any("Bash git activity" in result["title"] for result in rejections["results"])
    assert all("cost" not in selector.lower() for result in cost["results"] for selector in result["selectors"])

    # Every surfaced driver must clear its baseline with statistical confidence,
    # not merely on raw rate. The Wilson lower bound stays above the baseline.
    for section in (cost, fanout, tool_errors, rejections):
        baseline_rate = section["positive_count"] / section["baseline_count"]
        for result in section["results"]:
            assert result["subgroup_rate_low"] > baseline_rate


def test_discovery_applies_project_and_support_filters(seeded: tuple[sqlite3.Connection, int, int]) -> None:
    conn, alpha, beta = seeded

    alpha_payload = discovery_analytics(conn, project_id=alpha, min_support=3)
    beta_payload = discovery_analytics(conn, project_id=beta, min_support=3)
    strict_payload = discovery_analytics(conn, project_id=alpha, min_support=99)

    assert alpha_payload["meta"]["total_sessions"] == 36
    assert beta_payload["meta"]["total_sessions"] == 24
    assert alpha_payload["sections"]["cost"]["results"]
    assert not strict_payload["sections"]["cost"]["results"]


def test_discovery_empty_db_is_stable(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    csv = tmp_path / "pricing.csv"
    csv.write_text(
        "model,base-input-tokens,5m-cache-writes,1h-cache-writes,cache-hits-&-refreshes,output-tokens\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(discovery, "pricing_path", lambda: csv)
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)

    payload = discovery_analytics(conn)

    assert payload["meta"]["total_sessions"] == 0
    assert payload["sections"]["tool_errors"]["results"] == []
    assert payload["sections"]["rejections"]["baseline_count"] == 0


def test_discovery_endpoint_returns_payload(seeded: tuple[sqlite3.Connection, int, int], tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    conn, alpha, _beta = seeded
    monkeypatch.setattr("ccfr.main.database_path", lambda: tmp_path / "startup.sqlite3")
    app = create_app()
    app.dependency_overrides[get_db] = lambda: conn
    with TestClient(app) as client:
        response = client.get("/api/analytics/discovery", params={"project_id": alpha, "min_support": 3})

    assert response.status_code == 200
    body = response.json()
    assert body["meta"]["project_id"] == alpha
    assert body["sections"]["cost"]["available"] is True
    assert "tool_errors" in body["sections"]
