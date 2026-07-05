from __future__ import annotations

import os
from importlib.metadata import PackageNotFoundError, version as _pkg_version
from pathlib import Path


def repository_root() -> Path:
    return Path(__file__).resolve().parents[3]


def data_dir() -> Path:
    return Path(os.getenv("CCFR_DATA_DIR", str(repository_root() / ".ccfr-data")))


def import_root() -> Path:
    return Path(os.getenv("CCFR_IMPORT_ROOT", str(repository_root() / "Data")))


def demo_dir() -> Path:
    """Bundled synthetic demo export (Load-demo button and `serve --demo`)."""
    return Path(os.getenv("CCFR_DEMO_DIR", str(repository_root() / "demo" / "claude-export")))


def team_bundle_root() -> Path:
    return Path(os.getenv("CCFR_TEAM_BUNDLE_ROOT", str(data_dir() / "team-bundles")))


def resolve_within_import_root(candidate: str | None, root: Path | None = None) -> Path:
    """Resolve a request-supplied path, confining it to the import root.

    Falsy ``candidate`` yields the import root itself. Any other value must
    resolve to the import root or a descendant of it; otherwise ``ValueError``
    is raised. ``root`` overrides the configured import root (used so the API
    layer can honor a monkeypatched/runtime root).
    """
    base = (root if root is not None else import_root()).resolve()
    if not candidate:
        return base
    path = Path(candidate).resolve()
    if path != base and not path.is_relative_to(base):
        raise ValueError("source_path must be within the import root")
    return path


def resolve_within_team_bundle_root(candidate: str | None, root: Path | None = None) -> Path:
    """Resolve a request-supplied team bundle path, confining it to the team bundle root."""
    base = (root if root is not None else team_bundle_root()).resolve()
    if not candidate:
        return base
    path = Path(candidate).resolve()
    if path != base and not path.is_relative_to(base):
        raise ValueError("path must be within the team bundle root")
    return path


def validate_project_name(name: str) -> str:
    """Reject project names that could escape the source directory."""
    separators = {os.sep, os.altsep, "/", "\\"}
    if any(sep and sep in name for sep in separators) or name == "..":
        raise ValueError("project name must not contain path separators or '..'")
    return name


def database_path() -> Path:
    return Path(os.getenv("CCFR_DB_PATH", str(data_dir() / "ccfr.sqlite3")))


def pricing_path() -> Path:
    """CSV of per-model, per-million-token prices used for cost estimation."""
    return Path(os.getenv("CCFR_PRICING_PATH", str(repository_root() / "pricing.csv")))


def pricing_dir() -> Path:
    """Directory of dated price snapshots (pricing-YYYY-MM-DD.csv) layered over pricing.csv."""
    return Path(os.getenv("CCFR_PRICING_DIR", str(repository_root() / "pricing")))


def webui_dir() -> Path:
    """Directory of built SPA assets bundled into the package (see scripts/build_webui.py)."""
    return Path(os.getenv("CCFR_WEBUI_DIR", str(Path(__file__).resolve().parent / "webui")))


def allowed_origins() -> list[str]:
    """CORS origins permitted to call the API.

    Defaults to the local frontend dev server. Override with a comma-separated
    list in CCFR_ALLOWED_ORIGINS.
    """
    raw = os.getenv(
        "CCFR_ALLOWED_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173",
    )
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


def is_docker() -> bool:
    return Path("/.dockerenv").exists()


def app_version() -> str:
    """App release version for contribution bundles.

    Resolves from the installed ``check-your-agent`` package metadata so the
    version has a single source (``pyproject.toml``). Falls back to the pinned
    baseline when the package is not installed, e.g. a bare source checkout
    without an editable install.
    """
    try:
        return _pkg_version("check-your-agent")
    except PackageNotFoundError:
        return "0.1.0"
