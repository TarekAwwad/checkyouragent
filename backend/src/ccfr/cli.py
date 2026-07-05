from __future__ import annotations

import argparse
import os
import sys
import threading
import webbrowser
from collections.abc import Mapping, Sequence
from pathlib import Path


def default_import_root(env: Mapping[str, str] | None = None, home: Path | None = None) -> str:
    """Resolve the default import root for `serve`.

    Precedence: CCFR_IMPORT_ROOT env, else ~/.claude/projects if it is a
    directory, else ./Data (relative to the working directory).
    """
    env = os.environ if env is None else env
    configured = env.get("CCFR_IMPORT_ROOT")
    if configured:
        return configured
    home = Path.home() if home is None else home
    claude_projects = home / ".claude" / "projects"
    if claude_projects.is_dir():
        return str(claude_projects)
    return "./Data"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="check-your-agent",
        description="Local analytics for Claude Code project exports.",
    )
    subparsers = parser.add_subparsers(dest="command")

    serve = subparsers.add_parser("serve", help="Serve the app on localhost (the default).")
    serve.add_argument("--import-root", default=None,
                       help="Export root to scan (default: $CCFR_IMPORT_ROOT, else "
                            "~/.claude/projects, else ./Data).")
    serve.add_argument("--data-dir", default=None,
                       help="Directory for the SQLite cache and settings.")
    serve.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1).")
    serve.add_argument("--port", type=int, default=8000, help="Bind port (default: 8000).")
    serve.add_argument("--no-browser", action="store_true", help="Do not open a browser.")
    serve.add_argument("--demo", action="store_true",
                       help="Use the bundled synthetic demo dataset as the import root.")
    serve.set_defaults(func=_serve)

    # Extension point: P10 adds ONE line here -- `add_export_bundle_parser(subparsers)`
    # (plus its import at the top of this module). Any handler it registers must have
    # signature (args) -> int and call `set_defaults(func=...)`; main() dispatches via
    # args.func(args). Known-command detection (below) is derived from the parser, so
    # no other edit is needed for bare-invocation defaulting.
    return parser


def _known_commands(parser: argparse.ArgumentParser) -> set[str]:
    """Names of the registered subcommands, read back from the parser.

    Derived (not hardcoded) so a subcommand added inside build_parser() is
    recognized automatically by the "default to serve" logic in main().
    """
    for action in parser._actions:
        if isinstance(action, argparse._SubParsersAction):
            return set(action.choices)
    return set()


def _serve(args: argparse.Namespace) -> int:
    import_root = args.import_root or default_import_root()
    if args.demo:
        from ccfr.config import demo_dir  # lazy: keeps the CLI import cheap
        import_root = str(demo_dir())
    os.environ["CCFR_IMPORT_ROOT"] = str(Path(import_root).expanduser())
    if args.data_dir:
        os.environ["CCFR_DATA_DIR"] = str(Path(args.data_dir).expanduser())

    # Import AFTER the env vars are set so config resolves the right paths.
    import uvicorn
    from ccfr.config import webui_dir
    from ccfr.main import create_app

    url = f"http://{args.host}:{args.port}"
    has_ui = (webui_dir() / "index.html").is_file()
    if has_ui:
        print(f"Check Your Agent is serving at {url}")
    else:
        print(f"Check Your Agent API is serving at {url} (web UI assets not built).")
        print("To build the UI, run: python scripts/build_webui.py")
        print(f"API docs: {url}/docs")
    if not args.no_browser:
        target = url if has_ui else f"{url}/docs"
        threading.Timer(1.0, lambda: webbrowser.open(target)).start()
    uvicorn.run(create_app(), host=args.host, port=args.port, log_level="info")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    known = _known_commands(parser)
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv:
        argv = ["serve"]
    elif argv[0] not in known and argv[0] not in ("-h", "--help"):
        argv = ["serve", *argv]
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
