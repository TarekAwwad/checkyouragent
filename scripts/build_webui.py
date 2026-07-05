#!/usr/bin/env python3
"""Build the frontend and copy it into the ccfr package for wheel packaging.

Runs `npm ci && npm run build` in frontend/, then replaces
backend/src/ccfr/webui/ with the contents of frontend/dist/. The webui/ dir is
git-ignored and force-included in the wheel (see backend/pyproject.toml).
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


def _npm(*args: str) -> None:
    # shell=True so npm.cmd resolves on Windows; args are static and trusted.
    subprocess.run("npm " + " ".join(args), cwd=FRONTEND, check=True, shell=True)


def main() -> int:
    if not FRONTEND.is_dir():
        print(f"frontend/ not found at {FRONTEND}", file=sys.stderr)
        return 1
    _npm("ci")
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
