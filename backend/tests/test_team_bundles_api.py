from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from ccfr.api import routes
from ccfr.api.deps import get_db
from ccfr.analysis.team_bundles import bundle_content_id
from ccfr.ingest import import_export
from ccfr.main import create_app
from ccfr.storage import init_db
from tests.fixtures import sanitized_export


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    import ccfr.settings as settings_mod

    data_dir = tmp_path / "settings"
    bundle_root = tmp_path / "team-bundles"
    monkeypatch.setattr(settings_mod, "data_dir", lambda: data_dir)
    monkeypatch.setattr(routes, "team_bundle_root", lambda: bundle_root)
    monkeypatch.setattr("ccfr.main.database_path", lambda: tmp_path / "startup.sqlite3")

    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    init_db(conn)
    import_export(conn, sanitized_export(tmp_path))

    app = create_app()
    app.dependency_overrides[get_db] = lambda: conn
    with TestClient(app) as c:
        yield c, conn, bundle_root
    conn.close()


def test_config_exposes_team_bundle_root(client):
    c, _conn, bundle_root = client

    resp = c.get("/api/config")

    assert resp.status_code == 200
    assert resp.json()["team_bundle_root"] == str(bundle_root)


def test_team_export_writes_under_bundle_root_without_network(client, monkeypatch):
    import socket
    import urllib.request

    c, _conn, bundle_root = client

    def _no_net(*args, **kwargs):
        raise AssertionError("team bundle export must not make a network connection")

    monkeypatch.setattr(socket, "create_connection", _no_net)
    monkeypatch.setattr(urllib.request, "urlopen", _no_net)

    resp = c.post("/api/team/export")

    assert resp.status_code == 200
    body = resp.json()
    written = list((bundle_root / "exports").glob("team-bundle-*.json"))
    assert len(written) == 1
    assert body["path"] == str(written[0])
    parsed = json.loads(written[0].read_text(encoding="utf-8"))
    assert parsed["profile"] == "team_strict"
    assert parsed["bundle_id"] == body["bundle_id"]
    assert body["session_count"] == 3


def test_team_export_increments_seq_while_preview_does_not_consume_it(client):
    c, _conn, _bundle_root = client

    first = c.post("/api/team/export").json()
    first_bundle = json.loads(Path(first["path"]).read_text(encoding="utf-8"))
    assert first_bundle["generated_seq"] == 1

    preview_bundle = c.get("/api/team/export-preview").json()["bundle"]
    assert preview_bundle["generated_seq"] == 2

    # The preview above must not have burned a sequence number: the next real
    # export still gets 2, not 3.
    second = c.post("/api/team/export").json()
    second_bundle = json.loads(Path(second["path"]).read_text(encoding="utf-8"))
    assert second_bundle["generated_seq"] == 2


def test_team_import_is_no_network_and_idempotent(client, monkeypatch):
    import socket
    import urllib.request

    c, conn, bundle_root = client
    export = c.post("/api/team/export").json()

    def _no_net(*args, **kwargs):
        raise AssertionError("team bundle import must not make a network connection")

    monkeypatch.setattr(socket, "create_connection", _no_net)
    monkeypatch.setattr(urllib.request, "urlopen", _no_net)

    first = c.post("/api/team/import", json={"path": export["path"]})
    second = c.post("/api/team/import", json={"path": export["path"]})

    assert first.status_code == 200
    assert first.json()["imported"] is True
    assert second.status_code == 200
    assert second.json()["imported"] is False
    assert first.json()["bundle_id"] == second.json()["bundle_id"]
    assert len(c.get("/api/team/imports").json()) == 1
    assert conn.execute("SELECT COUNT(*) FROM team_bundles").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM team_bundle_sessions").fetchone()[0] == 3
    assert Path(export["path"]).is_relative_to(bundle_root)


def test_team_import_accepts_browser_selected_bundle_payload(client, monkeypatch):
    import socket
    import urllib.request

    c, conn, bundle_root = client
    bundle = c.get("/api/team/export-preview").json()["bundle"]

    def _no_net(*args, **kwargs):
        raise AssertionError("team bundle upload import must not make a network connection")

    monkeypatch.setattr(socket, "create_connection", _no_net)
    monkeypatch.setattr(urllib.request, "urlopen", _no_net)

    first = c.post(
        "/api/team/import-bundle",
        json={"filename": "..\\member-beta.json", "bundle": bundle},
    )
    second = c.post(
        "/api/team/import-bundle",
        json={"filename": "member-beta.json", "bundle": bundle},
    )

    assert first.status_code == 200
    assert first.json()["imported"] is True
    assert second.status_code == 200
    assert second.json()["imported"] is False
    assert first.json()["bundle_id"] == second.json()["bundle_id"]
    assert conn.execute("SELECT COUNT(*) FROM team_bundles").fetchone()[0] == 1
    source_path = c.get("/api/team/imports").json()[0]["source_path"]
    assert source_path == str(bundle_root / "browser-imports" / "member-beta.json")


def test_team_import_accepts_legacy_precanonical_export_hash(client):
    c, _conn, _bundle_root = client
    bundle = c.get("/api/team/export-preview").json()["bundle"]
    bundle["sessions"][0]["sequence"] = [
        {"sym": "CALL:mcp", "fam": "tool_call", "dt_s": 0, "out_tok": 1}
    ]
    raw_base = {key: bundle[key] for key in (
        "schema_version", "profile", "member_id", "generated_at", "app_version", "sessions",
    )}
    bundle["bundle_id"] = bundle_content_id(raw_base)

    resp = c.post("/api/team/import-bundle", json={"filename": "legacy-team-bundle.json", "bundle": bundle})

    assert resp.status_code == 200
    assert resp.json()["imported"] is True
    assert resp.json()["bundle_id"] != bundle["bundle_id"]
    dashboard = c.get("/api/team/dashboard").json()
    assert {"sym": "CALL:other", "count": 1} in dashboard["sequence"]


def test_team_import_rejects_outside_root_and_invalid_profile_schema(client, tmp_path):
    c, _conn, bundle_root = client
    bundle = c.get("/api/team/export-preview").json()["bundle"]

    outside = tmp_path / "outside-team-bundle.json"
    outside.write_text(json.dumps(bundle), encoding="utf-8")
    assert c.post("/api/team/import", json={"path": str(outside)}).status_code == 400

    bad_profile = {**bundle, "profile": "loose"}
    bad_profile_path = bundle_root / "bad-profile.json"
    bad_profile_path.parent.mkdir(parents=True, exist_ok=True)
    bad_profile_path.write_text(json.dumps(bad_profile), encoding="utf-8")
    resp = c.post("/api/team/import", json={"path": str(bad_profile_path)})
    assert resp.status_code == 400
    assert "profile" in resp.json()["detail"]

    bad_schema = {**bundle, "schema_version": 2}
    bad_schema_path = bundle_root / "bad-schema.json"
    bad_schema_path.write_text(json.dumps(bad_schema), encoding="utf-8")
    resp = c.post("/api/team/import", json={"path": str(bad_schema_path)})
    assert resp.status_code == 400
    assert "schema_version" in resp.json()["detail"]

    resp = c.post("/api/team/import-bundle", json={"filename": "bad-profile.json", "bundle": bad_profile})
    assert resp.status_code == 400
    assert "profile" in resp.json()["detail"]


def test_team_dashboard_aggregates_imported_bundles(client):
    c, _conn, _bundle_root = client
    export = c.post("/api/team/export").json()
    assert c.post("/api/team/import", json={"path": export["path"]}).status_code == 200

    resp = c.get("/api/team/dashboard")

    assert resp.status_code == 200
    body = resp.json()
    assert body["meta"]["bundle_count"] == 1
    assert body["meta"]["member_count"] == 1
    assert body["meta"]["session_count"] == 3
    assert body["tokens"]["input"] > 0
    assert body["tokens"]["output"] > 0
    assert {"provider": "claude", "session_count": 3} in body["providers"]
    assert any(item["reason"] == "tool_use" for item in body["stop_reasons"])
    assert any(item["agent_type"] == "general-purpose" for item in body["subagents"])
    assert body["over_time"]


def test_team_dashboard_reports_distinct_project_count(client):
    c, conn, _bundle_root = client
    export = c.post("/api/team/export").json()
    assert c.post("/api/team/import", json={"path": export["path"]}).status_code == 200

    expected = conn.execute(
        "SELECT COUNT(DISTINCT project_id) FROM team_bundle_sessions"
    ).fetchone()[0]
    body = c.get("/api/team/dashboard").json()

    assert expected > 0
    assert body["meta"].get("project_count") == expected


def test_team_cost_endpoint_returns_cost_shape(client):
    c, _conn, _bundle_root = client
    export = c.post("/api/team/export").json()
    assert c.post("/api/team/import", json={"path": export["path"]}).status_code == 200

    resp = c.get("/api/team/analytics/cost")

    assert resp.status_code == 200
    body = resp.json()
    assert body["sessions"] == []
    assert "meta" in body and "by_model" in body and "categories" in body


def test_team_cost_endpoint_filters_by_project_id(client):
    c, _conn, _bundle_root = client
    export = c.post("/api/team/export").json()
    assert c.post("/api/team/import", json={"path": export["path"]}).status_code == 200

    baseline = c.get("/api/team/analytics/cost").json()
    projects = baseline["meta"]["available_projects"]
    assert len(projects) == 2
    target_id = projects[0]["id"]

    resp = c.get("/api/team/analytics/cost", params={"project_id": target_id})

    assert resp.status_code == 200
    body = resp.json()
    # Filtering by one project's id must not drop it from the selector, and
    # must not leak the other project's spend into the treemap.
    assert len(body["meta"]["available_projects"]) == 2
    assert all(entry["project_id"] == target_id for entry in body["treemap"])


@pytest.fixture()
def imported_bundle(client):
    c, _conn, _bundle_root = client
    export = c.post("/api/team/export").json()
    assert c.post("/api/team/import", json={"path": export["path"]}).status_code == 200
    return c.get("/api/team/imports").json()[0]


def test_delete_member_endpoint(client, imported_bundle):
    c, _conn, _bundle_root = client
    member_id = imported_bundle["member_id"]

    response = c.delete(f"/api/team/members/{member_id}")

    assert response.status_code == 200
    assert response.json() == {"member_id": member_id, "bundles_removed": 1}
    assert c.delete(f"/api/team/members/{member_id}").status_code == 404


def test_team_reset_clears_only_team_tables(client):
    c, conn, _bundle_root = client
    export = c.post("/api/team/export").json()
    assert c.post("/api/team/import", json={"path": export["path"]}).status_code == 200
    assert c.get("/api/projects").json()

    resp = c.post("/api/team/reset")

    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    assert c.get("/api/team/dashboard").json()["meta"]["session_count"] == 0
    assert c.get("/api/projects").json()
    assert conn.execute("SELECT COUNT(*) FROM team_bundles").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM team_bundle_sessions").fetchone()[0] == 0
