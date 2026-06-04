from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from ccfr.api import routes
from ccfr.api.deps import get_db
from ccfr.main import create_app
from ccfr.storage import init_db


def _write_project(root: Path, name: str, session_id: str) -> None:
    project = root / name
    project.mkdir(parents=True, exist_ok=True)
    (project / f"{session_id}.jsonl").write_text(
        '{"type":"user","uuid":"u1","timestamp":"2026-01-01T00:00:00Z",'
        '"message":{"role":"user","content":"hello"}}',
        encoding="utf-8",
    )


def _write_risky_project(root: Path, name: str, session_id: str) -> None:
    project = root / name
    project.mkdir(parents=True, exist_ok=True)
    (project / f"{session_id}.jsonl").write_text(
        "\n".join([
            '{"type":"user","uuid":"u1","timestamp":"2026-01-01T00:00:00Z",'
            '"message":{"role":"user","content":"run tests"}}',
            '{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-01-01T00:00:01Z",'
            '"message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use",'
            '"id":"toolu_1","name":"Bash","input":{"command":"uv run pytest"}}]}}',
            '{"type":"user","uuid":"u2","parentUuid":"a1","timestamp":"2026-01-01T00:00:02Z",'
            '"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1",'
            '"is_error":true,"content":"Exit code 1\\npytest failed"}]}}',
        ]),
        encoding="utf-8",
    )


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    init_db(conn)
    # Point import_root() at our temp source tree, and keep startup's DB off the repo.
    monkeypatch.setattr(routes, "import_root", lambda: tmp_path)
    monkeypatch.setattr("ccfr.main.database_path", lambda: tmp_path / "startup.sqlite3")

    app = create_app()
    app.dependency_overrides[get_db] = lambda: conn
    with TestClient(app) as c:
        yield c, tmp_path
    conn.close()


def test_discover_then_import_single_project(client) -> None:
    c, root = client
    _write_project(root, "d--Alpha", "11111111-1111-1111-1111-111111111111")
    _write_project(root, "d--Beta", "22222222-2222-2222-2222-222222222222")

    discovered = c.get("/api/source/projects").json()
    names = {d["name"]: d for d in discovered}
    assert names["d--Alpha"]["imported"] is False

    resp = c.post("/api/imports", json={"project": "d--Alpha"})
    assert resp.status_code == 200
    assert resp.json()["project_count"] == 1

    discovered = {d["name"]: d for d in c.get("/api/source/projects").json()}
    assert discovered["d--Alpha"]["imported"] is True
    assert discovered["d--Beta"]["imported"] is False


def test_import_all_new_then_reset(client) -> None:
    c, root = client
    _write_project(root, "d--Alpha", "11111111-1111-1111-1111-111111111111")

    assert c.post("/api/imports", json={}).status_code == 200
    assert len(c.get("/api/projects").json()) == 1

    reset = c.post("/api/imports/reset")
    assert reset.status_code == 200
    assert reset.json() == {"ok": True}
    assert c.get("/api/projects").json() == []


def test_import_unknown_project_returns_400(client) -> None:
    c, root = client
    (root / "d--Alpha").mkdir()
    resp = c.post("/api/imports", json={"project": "d--Missing"})
    assert resp.status_code == 400


def test_import_outside_import_root_returns_400(client, tmp_path_factory) -> None:
    c, _root = client
    # A directory that exists but lives OUTSIDE the configured import root.
    outside = tmp_path_factory.mktemp("outside_root")
    _write_project(outside, "d--Evil", "44444444-4444-4444-4444-444444444444")

    resp = c.post("/api/imports", json={"source_path": str(outside)})
    assert resp.status_code == 400

    listing = c.get("/api/source/projects", params={"source_path": str(outside)})
    assert listing.status_code == 400


def test_import_project_name_with_traversal_returns_400(client) -> None:
    c, _root = client
    for bad in ["../etc", "..", "foo/bar", "foo\\bar"]:
        resp = c.post("/api/imports", json={"project": bad})
        assert resp.status_code == 400, bad


def test_import_progress_is_inactive_before_import(client) -> None:
    c, _root = client

    resp = c.get("/api/imports/progress")

    assert resp.status_code == 200
    assert resp.json() == {
        "active": False,
        "import_id": None,
        "status": "idle",
        "source_path": None,
        "project": None,
        "totals": None,
        "summary": None,
        "updated_at": None,
    }


def test_import_progress_reports_running_project(client, monkeypatch: pytest.MonkeyPatch) -> None:
    from ccfr.ingest import ImportSummary

    c, root = client
    ready = threading.Event()
    release = threading.Event()
    response: dict[str, object] = {}

    def fake_import_project(conn, source, project, *, progress_callback=None):
        cur = conn.execute(
            "INSERT INTO imports(source_path, imported_at, file_count, status) VALUES (?, ?, ?, ?)",
            (str(source / project), "2026-06-03T00:00:00Z", 1, "running"),
        )
        import_id = int(cur.lastrowid)
        summary = ImportSummary(import_id=import_id, source_path=str(source / project), file_count=1)
        project_id = int(conn.execute(
            "INSERT INTO projects(import_id, export_name) VALUES (?, ?)",
            (import_id, project),
        ).lastrowid)
        session_id = int(conn.execute(
            "INSERT INTO sessions(project_id, session_id) VALUES (?, ?)",
            (project_id, "11111111-1111-1111-1111-111111111111"),
        ).lastrowid)
        conn.execute(
            "INSERT INTO events(session_id, source_path, line_no, type, raw_json) VALUES (?, ?, ?, ?, ?)",
            (session_id, f"{project}/session.jsonl", 1, "user", "{}"),
        )
        if progress_callback is not None:
            progress_callback(summary, "importing")
        ready.set()
        assert release.wait(5)
        return summary

    monkeypatch.setattr(routes, "import_project", fake_import_project)

    thread = threading.Thread(
        target=lambda: response.setdefault("resp", c.post("/api/imports", json={"project": "d--Alpha"}))
    )
    thread.start()
    assert ready.wait(5)

    progress = c.get("/api/imports/progress").json()
    assert progress["active"] is True
    assert progress["project"] == "d--Alpha"
    assert progress["status"] == "importing"
    assert progress["totals"]["project_count"] == 1
    assert progress["totals"]["event_count"] == 1
    assert progress["summary"]["project_count"] == 1
    assert progress["summary"]["event_count"] == 1

    release.set()
    thread.join(5)
    assert response["resp"].status_code == 200
    assert c.get("/api/imports/progress").json()["active"] is False


def test_findings_endpoint_returns_pattern_evidence(client) -> None:
    c, root = client
    _write_risky_project(root, "d--Risky", "33333333-3333-3333-3333-333333333333")

    assert c.post("/api/imports", json={"project": "d--Risky"}).status_code == 200
    sessions = c.get("/api/sessions").json()
    assert sessions[0]["finding_count"] > 0
    assert sessions[0]["pattern_risk_score"] > 0

    resp = c.get(f"/api/sessions/{sessions[0]['id']}/findings")
    assert resp.status_code == 200
    findings = resp.json()
    assert findings
    assert findings[0]["pattern"]
    assert findings[0]["start_event_id"] is not None


def test_stats_reflect_current_cache(client) -> None:
    c, root = client

    empty = c.get("/api/stats")
    assert empty.status_code == 200
    assert empty.json() == {
        "project_count": 0,
        "session_count": 0,
        "event_count": 0,
        "subagent_count": 0,
        "memory_count": 0,
        "persisted_output_count": 0,
    }

    _write_project(root, "d--Alpha", "11111111-1111-1111-1111-111111111111")
    assert c.post("/api/imports", json={"project": "d--Alpha"}).status_code == 200

    stats = c.get("/api/stats").json()
    assert stats["project_count"] == 1
    assert stats["session_count"] == 1
    assert stats["event_count"] >= 1

    c.post("/api/imports/reset")
    assert c.get("/api/stats").json()["project_count"] == 0
