from __future__ import annotations

from collections.abc import Iterable, Iterator
from typing import TypedDict


class LoopContext(TypedDict):
    run_index: int
    position: int
    count: int
    tool_name: str
    start_index: int
    end_index: int


def _runs(names: list[str | None]) -> Iterator[tuple[int, int, str]]:
    """Yield (start_index, length, name) for consecutive identical non-null names."""
    start = 0
    while start < len(names):
        name = names[start]
        if name is None:
            start += 1
            continue
        end = start + 1
        while end < len(names) and names[end] == name:
            end += 1
        yield start, end - start, name
        start = end


def compute_loop_stats(names: Iterable[str | None], *, min_run: int = 3) -> tuple[int, int]:
    """Return (loop_count, max_repeat) for a chronological list of tool names.

    loop_count = number of runs whose length >= min_run.
    max_repeat = length of the longest consecutive identical run (0 if no names).
    """
    names = list(names)
    loop_count = 0
    max_repeat = 0
    for _start, length, _name in _runs(names):
        max_repeat = max(max_repeat, length)
        if length >= min_run:
            loop_count += 1
    return loop_count, max_repeat


def loop_indices(names: Iterable[str | None], *, min_run: int = 3) -> set[int]:
    """Return the set of indices belonging to runs of length >= min_run."""
    names = list(names)
    marked: set[int] = set()
    for start, length, _name in _runs(names):
        if length >= min_run:
            marked.update(range(start, start + length))
    return marked


def loop_contexts(names: Iterable[str | None], *, min_run: int = 3) -> dict[int, LoopContext]:
    """Return per-index context for qualifying repeated-name runs."""
    names = list(names)
    contexts: dict[int, LoopContext] = {}
    run_index = 0
    for start, length, name in _runs(names):
        if length < min_run:
            continue
        run_index += 1
        for offset in range(length):
            contexts[start + offset] = {
                "run_index": run_index,
                "position": offset + 1,
                "count": length,
                "tool_name": name,
                "start_index": start,
                "end_index": start + length - 1,
            }
    return contexts
