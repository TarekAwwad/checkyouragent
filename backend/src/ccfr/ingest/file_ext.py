"""Extension-only file-type extraction for tool calls.

Derive-then-drop: the file path in a tool call's input is parsed for its
extension at ingest time and immediately discarded. Only the normalized
extension is stored (tool_calls.file_ext), so team bundles can report a
file-type mix without the export builder ever reading raw tool inputs.
"""
from __future__ import annotations

import re
from typing import Any

# Tools whose input names a single file the assistant touched.
FILE_ARG_TOOLS = frozenset({"Read", "Edit", "Write", "MultiEdit", "NotebookEdit"})

_EXT_RE = re.compile(r"^[a-z0-9_+-]{1,12}\Z")


def file_ext_from_tool_input(tool_name: Any, input_obj: Any) -> str | None:
    """Return the normalized extension of a file-arg tool call, else None."""
    if tool_name not in FILE_ARG_TOOLS or not isinstance(input_obj, dict):
        return None
    raw_path = input_obj.get("file_path") or input_obj.get("notebook_path")
    if not isinstance(raw_path, str) or not raw_path.strip():
        return None
    basename = raw_path.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]
    if "." not in basename.lstrip("."):
        return None  # extensionless file or bare dotfile (".env")
    ext = basename.rsplit(".", 1)[-1].strip().lower()
    return ext if _EXT_RE.match(ext) else None
