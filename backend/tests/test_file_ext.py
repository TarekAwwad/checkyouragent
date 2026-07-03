from __future__ import annotations

from ccfr.ingest.file_ext import file_ext_from_tool_input


def test_extracts_lowercased_extension_from_file_path():
    assert file_ext_from_tool_input("Read", {"file_path": "src/app/Main.TSX"}) == "tsx"
    assert file_ext_from_tool_input("Edit", {"file_path": "D:\\Code\\x\\importer.py"}) == "py"
    assert file_ext_from_tool_input("NotebookEdit", {"notebook_path": "nb/analysis.ipynb"}) == "ipynb"


def test_multi_dot_names_keep_only_the_last_extension():
    assert file_ext_from_tool_input("Write", {"file_path": "dist/archive.tar.gz"}) == "gz"


def test_extensionless_dotfile_and_non_file_tools_yield_none():
    assert file_ext_from_tool_input("Read", {"file_path": "Makefile"}) is None
    assert file_ext_from_tool_input("Read", {"file_path": ".env"}) is None
    assert file_ext_from_tool_input("Bash", {"command": "cat notes.txt"}) is None
    assert file_ext_from_tool_input("Read", None) is None
    assert file_ext_from_tool_input("Read", {"file_path": "   "}) is None


def test_weird_or_oversized_extensions_are_dropped():
    assert file_ext_from_tool_input("Read", {"file_path": "a.b/c.d e"}) is None  # space fails the charset
    assert file_ext_from_tool_input("Read", {"file_path": "x." + "y" * 13}) is None  # > 12 chars
