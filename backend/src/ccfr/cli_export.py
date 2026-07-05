"""`check-your-agent export-bundle`: headless team-bundle export.

Imports the configured export root into a rebuildable SQLite cache, then reuses
the exact privacy-controlled allowlist in ``analysis/team_bundles.build_team_bundle``
(the same path the /api/team/export route uses) to write a content-free bundle.
No sanitization logic lives here.
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import replace
from datetime import date
from pathlib import Path
from typing import Any

from ccfr import config
from ccfr.analysis.team_bundles import build_team_bundle, team_bundle_manifest
from ccfr.ingest import import_export
from ccfr.settings import contributor_identity, read_settings, write_settings
from ccfr.storage import connect, init_db, reset_db

LEVELS = ("structural", "team")


def add_export_bundle_parser(subparsers: Any) -> argparse.ArgumentParser:
    """Register the ``export-bundle`` subcommand on P07's subparsers object."""
    parser = subparsers.add_parser(
        "export-bundle",
        help="Build a content-free team bundle headlessly (import + export in one command).",
        description=(
            "Import the configured export root into a local cache and write a "
            "content-free team bundle, without running the app."
        ),
    )
    parser.add_argument(
        "--level", choices=LEVELS, default="structural",
        help="Privacy level (default: structural — no names, no tool/file labels).",
    )
    parser.add_argument(
        "--out", default=None, metavar="PATH",
        help="Output JSON path (default: ./team-bundle-<date>.json).",
    )
    parser.add_argument(
        "--import-root", default=None, metavar="PATH",
        help="Export root to scan (default: CCFR_IMPORT_ROOT, else ./Data).",
    )
    parser.add_argument(
        "--projects", nargs="+", default=None, metavar="EXPORT_NAME",
        help="Only these export folder names (default: every imported project).",
    )
    parser.add_argument(
        "--member-name", default=None, metavar="NAME",
        help="Your display name (required for --level team; forbidden otherwise).",
    )
    parser.add_argument(
        "--fresh", action="store_true",
        help="Rebuild the cache from scratch before exporting.",
    )
    parser.add_argument(
        "--force", action="store_true",
        help="Overwrite the output file if it already exists.",
    )
    parser.add_argument(
        "--yes", action="store_true",
        help="Skip the interactive confirmation prompt.",
    )
    parser.set_defaults(func=run_export_bundle)
    return parser


def _confirm() -> bool:
    try:
        reply = input("Proceed with export? [y/N] ").strip().lower()
    except EOFError:
        return False
    return reply in {"y", "yes"}


def _print_privacy_summary(
    manifest: dict[str, Any], out_path: Path, level: str, session_count: int
) -> None:
    print(f"Team bundle export — privacy level: {level}")
    print(f"  {session_count} session(s) -> {out_path}")
    print("  INCLUDED:")
    for item in manifest["included_fields"]:
        print(f"    + {item}")
    print("  NOT included:")
    for item in manifest["excluded"]:
        print(f"    - {item}")
    print(f"  Note: {manifest['fingerprint_caveat']}")


def run_export_bundle(args: argparse.Namespace) -> int:
    level = args.level
    member_name = (args.member_name or "").strip() or None

    # Fail fast on the usage errors before touching the filesystem or importing.
    if level == "team" and member_name is None:
        print("error: --member-name is required for --level team", file=sys.stderr)
        return 2
    if level == "structural" and member_name is not None:
        print("error: --member-name is only valid with --level team", file=sys.stderr)
        return 2

    root = Path(args.import_root).expanduser() if args.import_root else config.import_root()
    out_path = (
        Path(args.out).expanduser() if args.out
        else Path(f"./team-bundle-{date.today().isoformat()}.json")
    )
    if out_path.exists() and not args.force:
        print(f"error: {out_path} already exists (use --force to overwrite)", file=sys.stderr)
        return 1

    conn = connect(config.database_path())
    try:
        if args.fresh:
            reset_db(conn)
        else:
            init_db(conn)
        try:
            import_export(conn, root)
        except (FileNotFoundError, ValueError, OSError) as exc:
            print(f"error: cannot read export root {root}: {exc}", file=sys.stderr)
            return 1

        # Same identity + sequence flow as /api/team/export (routes.py::_current_team_bundle).
        salt, member_id = contributor_identity()
        settings = read_settings()
        seq = settings.team_bundle_seq + 1
        projects = (
            [{"export_name": name, "label": None} for name in args.projects]
            if args.projects else None
        )
        try:
            bundle = build_team_bundle(
                conn,
                salt=salt,
                member_id=member_id,
                app_version=config.app_version(),
                generated_on=date.today(),
                generated_seq=seq,
                privacy_level=level,
                member_name=member_name,
                projects=projects,
            )
        except ValueError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
    finally:
        conn.close()

    _print_privacy_summary(team_bundle_manifest(bundle), out_path, level, len(bundle.sessions))
    if not args.yes and not _confirm():
        print("Aborted; nothing written.")
        return 1

    data = bundle.to_dict()
    mode = "w" if args.force else "x"
    try:
        with out_path.open(mode, encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
    except FileExistsError:
        print(f"error: {out_path} already exists (use --force to overwrite)", file=sys.stderr)
        return 1

    # Persist the export sequence so same-day bundles from this member order
    # correctly on import (mirrors the app; identity is preserved by write_settings).
    write_settings(replace(settings, team_bundle_seq=seq))
    print(f"Wrote {level} bundle ({len(bundle.sessions)} session(s)) to {out_path}")
    print(f"bundle_id: {data['bundle_id']}")
    return 0
