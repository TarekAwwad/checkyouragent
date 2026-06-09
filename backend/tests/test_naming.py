# backend/tests/test_naming.py
from __future__ import annotations

from ccfr.naming import project_display_name


def test_leaf_from_windows_cwd() -> None:
    assert project_display_name("d--Cheqd-Code-agent-dashboard", "d:\\Cheqd\\Code\\agent-dashboard") == "agent-dashboard"


def test_leaf_from_posix_cwd() -> None:
    assert project_display_name("home-user-proj", "/home/user/proj") == "proj"


def test_trailing_separator_is_ignored() -> None:
    assert project_display_name("anything", "/home/user/proj/") == "proj"


def test_falls_back_to_export_name_without_cwd() -> None:
    assert project_display_name("d--Cheqd-Code-agent-dashboard", None) == "d--Cheqd-Code-agent-dashboard"
    assert project_display_name("raw-name", "") == "raw-name"
