from __future__ import annotations

import os
from importlib.metadata import PackageNotFoundError, version as _pkg_version
from pathlib import Path


def repository_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _source_checkout_root() -> Path | None:
    """repository_root() when running from a source tree, else None.

    The backend project file is the discriminator: it exists in a checkout (and
    in the Docker image, which mirrors the checkout layout) but never under
    site-packages, where repository_root()'s parents[3] guess lands when the
    package is installed from a wheel (pip/uvx).
    """
    try:
        root = repository_root()
    except IndexError:  # installed at an unusually shallow path
        return None
    if (root / "backend" / "pyproject.toml").is_file():
        return root
    return None


def _packaged_assets_dir() -> Path:
    """Data assets (pricing, demo export) staged into the wheel by scripts/build_webui.py."""
    return Path(__file__).resolve().parent / "_assets"


def _from_env_or_source(env_var: str, source_rel: str) -> Path | None:
    """Shared head of every asset ladder: the env override wins, then the
    source-checkout location; None means installed-from-wheel, where each
    caller supplies its own packaged (or home-dir) fallback."""
    configured = os.getenv(env_var)
    if configured:
        return Path(configured)
    source = _source_checkout_root()
    if source is not None:
        return source / source_rel
    return None


def data_dir() -> Path:
    resolved = _from_env_or_source("CCFR_DATA_DIR", ".ccfr-data")
    if resolved is not None:
        return resolved
    try:
        home = Path.home()
    except RuntimeError as exc:  # no HOME and no passwd entry (bare containers)
        raise RuntimeError(
            "cannot determine a home directory for the default data dir; set CCFR_DATA_DIR"
        ) from exc
    return home / ".checkyouragent"


def import_root() -> Path:
    return Path(os.getenv("CCFR_IMPORT_ROOT", str(repository_root() / "Data")))


def demo_dir() -> Path:
    """Bundled synthetic demo export (Load-demo button and `serve --demo`)."""
    resolved = _from_env_or_source("CCFR_DEMO_DIR", "demo/claude-export")
    return resolved if resolved is not None else _packaged_assets_dir() / "claude-export"


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
    resolved = _from_env_or_source("CCFR_PRICING_PATH", "pricing.csv")
    return resolved if resolved is not None else _packaged_assets_dir() / "pricing.csv"


def pricing_dir() -> Path:
    """Directory of dated price snapshots (pricing-YYYY-MM-DD.csv) layered over pricing.csv.

    Snapshots are optional local data (git-ignored; compose mounts them into
    Docker), so wheels never package any -- installed apps look under the data
    dir, where users can actually drop snapshot files."""
    resolved = _from_env_or_source("CCFR_PRICING_DIR", "pricing")
    return resolved if resolved is not None else data_dir() / "pricing"


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

    Resolves from the installed ``checkyouragent`` package metadata so the
    version has a single source (``pyproject.toml``). Falls back to the pinned
    baseline when the package is not installed, e.g. a bare source checkout
    without an editable install.
    """
    try:
        return _pkg_version("checkyouragent")
    except PackageNotFoundError:
        return "0.1.0"
