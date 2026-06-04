from __future__ import annotations

from typing import Any

from ccfr.analysis.metrics import loop_contexts


def build_trace(
    *,
    session_id: int,
    rows: list[dict[str, Any]],
    result_ts_by_use_id: dict[str, str],
) -> dict[str, Any]:
    """Build a lane/span trace from chronological event rows.

    Each row needs: event_id, kind, timestamp, tool_name, tool_use_id, agent_id, is_sidechain.
    `result_ts_by_use_id` maps a tool_use_id to its tool_result timestamp (span end).
    """
    spans: list[dict[str, Any]] = []
    lanes: list[dict[str, Any]] = []
    seen_lanes: set[str] = set()

    # Loop marking only applies to main-lane tool calls, in order.
    main_tool_event_ids = [
        r["event_id"] for r in rows
        if not r["is_sidechain"] and r["kind"] == "tool_call"
    ]
    main_tool_names = [
        r["tool_name"] for r in rows
        if not r["is_sidechain"] and r["kind"] == "tool_call"
    ]
    looped_positions = loop_contexts(main_tool_names)
    loop_context_by_event_id = {
        main_tool_event_ids[index]: context
        for index, context in looped_positions.items()
    }

    timestamps = [r["timestamp"] for r in rows if r["timestamp"]]
    first_ts = timestamps[0] if timestamps else None
    last_ts = timestamps[-1] if timestamps else None

    for row in rows:
        lane_id = row["agent_id"] if (row["is_sidechain"] and row["agent_id"]) else "main"
        if lane_id not in seen_lanes:
            seen_lanes.add(lane_id)
            lanes.append({
                "lane_id": lane_id,
                "label": "main thread" if lane_id == "main" else lane_id,
                "kind": "main" if lane_id == "main" else "subagent",
            })
        tool_use_id = row.get("tool_use_id")
        end_ts = (
            result_ts_by_use_id.get(tool_use_id)
            if row["kind"] == "tool_call" and tool_use_id
            else None
        )
        loop_context = loop_context_by_event_id.get(row["event_id"])
        spans.append({
            "id": f"span-{row['event_id']}",
            "event_id": row["event_id"],
            "lane": lane_id,
            "kind": row["kind"],
            "input_tokens": int(row.get("input_tokens") or 0),
            "output_tokens": int(row.get("output_tokens") or 0),
            "model": row.get("model"),
            "start_ts": row["timestamp"],
            "end_ts": end_ts,
            "tool_use_id": tool_use_id,
            "tool_name": row.get("tool_name"),
            "is_loop": loop_context is not None,
            "loop_run_id": (
                f"main-tool-loop-{loop_context['run_index']}"
                if loop_context is not None
                else None
            ),
            "loop_position": loop_context["position"] if loop_context is not None else None,
            "loop_count": loop_context["count"] if loop_context is not None else None,
            "loop_start_event_id": (
                main_tool_event_ids[loop_context["start_index"]]
                if loop_context is not None
                else None
            ),
            "loop_end_event_id": (
                main_tool_event_ids[loop_context["end_index"]]
                if loop_context is not None
                else None
            ),
        })

    return {
        "session_id": session_id,
        "first_ts": first_ts,
        "last_ts": last_ts,
        "lanes": lanes,
        "spans": spans,
    }
