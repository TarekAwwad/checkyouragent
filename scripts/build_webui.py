#!/usr/bin/env python3
"""Build the frontend and stage all packaged assets for wheel packaging.

Runs `npm ci && npm run build` in frontend/, then replaces
backend/src/ccfr/webui/ with the contents of frontend/dist/, and stages the
runtime data assets (pricing.csv, demo/claude-export/) into
backend/src/ccfr/_assets/. Both directories are git-ignored and force-included
in the wheel (see backend/pyproject.toml); ccfr.config falls back to _assets/
when not running from a source checkout.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
FRONTEND = REPO / "frontend"
DIST = FRONTEND / "dist"
WEBUI = REPO / "backend" / "src" / "ccfr" / "webui"
ASSETS = REPO / "backend" / "src" / "ccfr" / "_assets"


def _npm(*args: str) -> None:
    # shell=True so npm.cmd resolves on Windows; args are static and trusted.
    subprocess.run("npm " + " ".join(args), cwd=FRONTEND, check=True, shell=True)


def stage_data_assets() -> None:
    """Copy the repo-root data assets the installed app needs into the package.

    Must stage every location ccfr.config falls back to under _assets/;
    a missing source here means installed wheels silently lose that asset.
    """
    if ASSETS.exists():
        shutil.rmtree(ASSETS)
    ASSETS.mkdir(parents=True)
    shutil.copy2(REPO / "pricing.csv", ASSETS / "pricing.csv")
    shutil.copytree(REPO / "demo" / "claude-export", ASSETS / "claude-export")
    print(f"Staged pricing.csv and demo/claude-export -> {ASSETS}")


def main() -> int:
    if not FRONTEND.is_dir():
        print(f"frontend/ not found at {FRONTEND}", file=sys.stderr)
        return 1
    stage_data_assets()
    # --ignore-scripts: this build produces the published wheel's bundled UI, so
    # don't run install-time lifecycle scripts from the npm dependency tree. The
    # Vite/tsc build uses esbuild via its JS API and does not need them (verified
    # against a clean install).
    _npm("ci", "--ignore-scripts")
    _npm("run", "build")
    if not (DIST / "index.html").is_file():
        print(f"build produced no index.html at {DIST}", file=sys.stderr)
        return 1
    if WEBUI.exists():
        shutil.rmtree(WEBUI)
    shutil.copytree(DIST, WEBUI)
    print(f"Copied {DIST} -> {WEBUI}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
