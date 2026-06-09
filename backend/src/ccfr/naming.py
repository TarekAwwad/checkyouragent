# backend/src/ccfr/naming.py
"""Human-friendly project labels.

Claude Code stores each project under a folder whose name encodes the full cwd path
(e.g. ``d--Cheqd-Code-agent-dashboard`` for ``d:\\Cheqd\\Code\\agent-dashboard``). That
encoding is lossy — path separators and literal hyphens both become ``-`` — so it cannot
be decoded back into the leaf folder name. Instead we derive the label from the real cwd
captured on import (``inferred_cwd``), falling back to the raw export name when unknown.
"""
from __future__ import annotations


def project_display_name(export_name: str, inferred_cwd: str | None) -> str:
    """Leaf folder of ``inferred_cwd`` (the real project path), else ``export_name`` as-is."""
    if inferred_cwd:
        leaf = inferred_cwd.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]
        if leaf:
            return leaf
    return export_name
