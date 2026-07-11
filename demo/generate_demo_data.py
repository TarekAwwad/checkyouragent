#!/usr/bin/env python3
"""Deterministic synthetic Claude Code export generator for Check Your Agent.

Writes a fully synthetic `.claude/projects`-shaped export under an output
directory (default: <repo>/demo/claude-export). Seeded and stable: regenerating
yields byte-identical files, so both this script AND its output are committed.
Every value is fake -- project names are `demo-*`, file paths and commands are
invented, and there is no real session content.

The corpus is engineered so every analytics surface lights up:
  * cost analytics (cache economics, spend spikes, model mix, 8-week trend)
  * context economics -- findings in all four archetypes
      (redundant re-reads, oversized results, late compaction, stale continuation)
  * subgroup discovery -- at least one significant high-cost subgroup
  * triage board (errors, loops, subagent fanout), usage map / characteristics

Run:  python demo/generate_demo_data.py [output_dir] [scale]

`scale` (also read from $CCFR_DEMO_SCALE; default 1) is a sessions-only density
multiplier: `scale=4` writes ~4x the sessions per project so the demo dashboards
and landing "shots" read denser. Token sizes and the ~8-week window are held
fixed, so every detector still fires and `scale=1` stays byte-identical to the
committed export.
"""
from __future__ import annotations

import json
import os
import random
import shutil
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

SEED = 20260705
# Anchor 8 weeks back from a fixed Monday so weekly trend buckets fill.
REF = datetime(2026, 6, 29, 9, 0, 0, tzinfo=timezone.utc)

OPUS = "claude-opus-4-8"
SONNET = "claude-sonnet-4-6"
HAIKU = "claude-haiku-4-5"

# Detector-facing token sizes. See module docstring / plan: these clear the
# context-economics thresholds (oversized floor 5_000, compaction pressure
# 100_000, stale context p75).
NEW_WRITE = 2_000          # cache-creation (5m) tokens per call; the rest is cache-read
REREAD_DELTA = 3_200       # context growth attributed to a re-read's result
OVERSIZED_DELTA = 42_000   # single tool result far above the corpus norm
# Long, realistic-looking file body so a re-read's tool_result dominates its gap
# (otherwise the tiny assistant_output would absorb the growth and the finding
# would fall below MIN_FINDING_USD).
REREAD_BODY = (
    "export function cart(items) { /* demo cart logic */ "
    "return items.map((i) => i.price * i.qty); }\n"
) * 18

_COMPACTION_SEQ = [
    20_000, 45_000, 70_000, 95_000, 108_000, 116_000, 122_000,
    128_000, 133_000, 138_000, 142_000, 146_000, 150_000,
]
_STALE_SEQ = [5_000, 20_000, 40_000, 62_000, 80_000, 92_000, 93_000, 94_000]
_POWER_FILES = ["etl/extract.py", "etl/transform.py", "etl/load.py", "etl/validate.py"]
# Cluster expensive `power` work into 3 spend spikes. The per-spike session
# count grows with the demo SCALE factor, so the day list is derived from the
# actual power-session total (see `_power_days`) rather than hardcoded.
_SPIKE_DAYS = [3, 17, 38]


def _power_days(total: int) -> list[int]:
    """Spread `total` power sessions across _SPIKE_DAYS, keeping spikes even.

    At the default scale (6 power sessions) this reproduces the original
    [3, 3, 17, 17, 38, 38] byte-for-byte."""
    base, extra = divmod(total, len(_SPIKE_DAYS))
    days: list[int] = []
    for i, day in enumerate(_SPIKE_DAYS):
        days.extend([day] * (base + (1 if i < extra else 0)))
    return days


@dataclass
class Tool:
    name: str
    input: dict
    result: str
    is_error: bool = False
    persisted: str | None = None   # relpath under out_dir for a large captured output


@dataclass
class Call:
    context: int
    output: int
    model: str = OPUS
    text: str | None = None
    tools: list[Tool] = field(default_factory=list)
    gap_before_seconds: int | None = None   # inject a long idle gap before this call


@dataclass
class Builder:
    rng: random.Random
    uid: int = 0
    clock: datetime = REF

    def next_uuid(self) -> str:
        self.uid += 1
        return _uuid(0xE, self.uid)


def _uuid(kind: int, n: int) -> str:
    return f"{kind:08x}-0000-4000-8000-{n:012x}"


def _ts(dt: datetime) -> str:
    return dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _usage(context: int, output: int) -> dict:
    write = min(NEW_WRITE, max(0, context - 4))
    read = max(0, context - 4 - write)
    return {
        "input_tokens": 4,
        "cache_creation_input_tokens": write,
        "cache_creation": {
            "ephemeral_5m_input_tokens": write,
            "ephemeral_1h_input_tokens": 0,
        },
        "cache_read_input_tokens": read,
        "output_tokens": output,
    }


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text(
        "\n".join(json.dumps(row, separators=(",", ":")) for row in rows),
        encoding="utf-8",
    )


def build_session(b: Builder, start: datetime, prompt: str, calls: list[Call],
                  cwd: str, branch: str) -> list[dict]:
    b.clock = start
    rows: list[dict] = []
    sys_u = b.next_uuid()
    rows.append({"type": "system", "uuid": sys_u, "timestamp": _ts(b.clock),
                 "cwd": cwd, "version": "1.4.0", "entrypoint": "cli", "gitBranch": branch})
    b.clock += timedelta(seconds=5)
    prompt_u = b.next_uuid()
    rows.append({"type": "user", "uuid": prompt_u, "parentUuid": sys_u, "timestamp": _ts(b.clock),
                 "message": {"role": "user", "content": prompt}})
    parent = prompt_u
    for call in calls:
        gap = call.gap_before_seconds if call.gap_before_seconds is not None else b.rng.randint(20, 90)
        b.clock += timedelta(seconds=gap)
        a_u = b.next_uuid()
        content: list[dict] = []
        if call.text:
            content.append({"type": "text", "text": call.text})
        for j, tool in enumerate(call.tools):
            content.append({"type": "tool_use", "id": f"{a_u}-{j}", "name": tool.name, "input": tool.input})
        rows.append({"type": "assistant", "uuid": a_u, "parentUuid": parent, "timestamp": _ts(b.clock),
                     "message": {"id": f"msg-{a_u}", "role": "assistant", "model": call.model,
                                 "stop_reason": "tool_use" if call.tools else "end_turn",
                                 "content": content, "usage": _usage(call.context, call.output)}})
        parent = a_u
        if call.tools:
            b.clock += timedelta(seconds=3)
            r_u = b.next_uuid()
            blocks = []
            for j, tool in enumerate(call.tools):
                text = tool.result
                if tool.persisted:
                    text = f"Full output saved to: {tool.persisted}\n{tool.result}"
                blocks.append({"type": "tool_result", "tool_use_id": f"{a_u}-{j}",
                               "is_error": tool.is_error, "content": text})
            rows.append({"type": "user", "uuid": r_u, "parentUuid": a_u, "timestamp": _ts(b.clock),
                         "message": {"role": "user", "content": blocks}})
            parent = r_u
    return rows


def build_subagents(project_dir: Path, session_uuid: str, b: Builder, count: int) -> None:
    sub_dir = project_dir / session_uuid / "subagents"
    sub_dir.mkdir(parents=True, exist_ok=True)
    for k in range(count):
        agent_id = f"{k + 1:02d}"
        (sub_dir / f"agent-{agent_id}.meta.json").write_text(
            json.dumps({
                "agentType": ["general-purpose", "Explore", "code-reviewer"][k % 3],
                "description": "Synthetic demo subagent.",
                "name": f"agent-{agent_id}",
                "toolUseId": f"demo-agent-{session_uuid}-{agent_id}",
            }, indent=2),
            encoding="utf-8",
        )
        u = b.next_uuid()
        a = b.next_uuid()
        rows = [
            {"type": "user", "uuid": u, "timestamp": _ts(b.clock),
             "message": {"role": "user", "content": "Investigate a demo pipeline stage."}},
            {"type": "assistant", "uuid": a, "parentUuid": u, "timestamp": _ts(b.clock),
             "message": {"id": f"msg-{a}", "role": "assistant", "model": SONNET,
                         "stop_reason": "end_turn",
                         "content": [{"type": "text", "text": "Stage looks healthy (demo)."}],
                         "usage": _usage(4_000, 300)}},
        ]
        _write_jsonl(sub_dir / f"agent-{agent_id}.jsonl", rows)


# --- Per-archetype call factories -------------------------------------------
# Each returns a list[Call]. Factories that need the on-disk location take
# (b, project_name, session_uuid); the rest ignore those args.

def normal_calls(b: Builder, project_name: str, session_uuid: str) -> list[Call]:
    files = ["src/app/routes.ts", "src/app/store.ts", "src/lib/api.ts", "src/components/Cart.tsx"]
    ctx = b.rng.randint(2_500, 4_000)
    calls: list[Call] = []
    for _ in range(b.rng.randint(3, 6)):
        ctx += b.rng.randint(1_200, 2_400)
        pick = b.rng.randint(0, 3)
        if pick == 0:
            tool = Tool("Read", {"file_path": b.rng.choice(files)}, "// demo file contents")
        elif pick == 1:
            tool = Tool("Grep", {"pattern": "TODO"}, "2 matches (demo)")
        elif pick == 2:
            tool = Tool("Edit", {"file_path": b.rng.choice(files)}, "edit applied (demo)")
        else:
            tool = Tool("Bash", {"command": "npm run lint"}, "0 problems (demo)")
        calls.append(Call(context=ctx, output=b.rng.randint(200, 700),
                          model=b.rng.choice([OPUS, SONNET]),
                          text="Working on the demo task.", tools=[tool]))
    return calls


def reread_calls(b: Builder, project_name: str, session_uuid: str) -> list[Call]:
    path = "src/checkout/cart.ts"
    ctx = 4_000
    calls = [Call(ctx, output=30, tools=[Tool("Read", {"file_path": path}, REREAD_BODY)])]
    ctx += REREAD_DELTA
    calls.append(Call(ctx, output=280, tools=[Tool("Grep", {"pattern": "cart"}, "3 matches (demo)")]))
    ctx += 1_500
    calls.append(Call(ctx, output=220, tools=[Tool("Bash", {"command": "npm test"}, "PASS (demo)")]))
    ctx += 1_500
    calls.append(Call(ctx, output=30, tools=[Tool("Read", {"file_path": path}, REREAD_BODY)]))
    ctx += REREAD_DELTA
    calls.append(Call(ctx, output=210, tools=[Tool("Bash", {"command": "npm run build"}, "built (demo)")]))
    ctx += 1_200
    calls.append(Call(ctx, output=200, tools=[Tool("Read", {"file_path": "src/index.ts"}, "// demo")]))
    return calls


def oversized_calls(b: Builder, project_name: str, session_uuid: str) -> list[Call]:
    persisted = f"{project_name}/{session_uuid}/tool-results/catalog-export.txt"
    ctx = 5_000
    calls = [Call(ctx, output=220, tools=[Tool("Read", {"file_path": "src/api/routes.ts"}, "// demo")])]
    ctx += 1_500
    calls.append(Call(ctx, output=0, tools=[Tool(
        "Bash", {"command": "npm run export:catalog -- --full"},
        "catalog export (demo)", persisted=persisted)]))
    ctx += OVERSIZED_DELTA
    calls.append(Call(ctx, output=200, tools=[Tool("Grep", {"pattern": "sku"}, "ok (demo)")]))
    ctx += 1_500
    calls.append(Call(ctx, output=200, tools=[Tool("Read", {"file_path": "src/api/schema.ts"}, "// demo")]))
    ctx += 1_500
    calls.append(Call(ctx, output=200, tools=[Tool("Bash", {"command": "npm test"}, "PASS (demo)")]))
    return calls


def late_compaction_calls(b: Builder, project_name: str, session_uuid: str) -> list[Call]:
    return [Call(context=c, output=0, model=OPUS, text="Continuing the long demo investigation.")
            for c in _COMPACTION_SEQ]


def stale_calls(b: Builder, project_name: str, session_uuid: str) -> list[Call]:
    calls: list[Call] = []
    for i, c in enumerate(_STALE_SEQ):
        calls.append(Call(
            context=c, output=0, model=OPUS,
            text="Quick follow-up on the demo analysis." if i >= 6 else "Analyzing the demo dataset.",
            gap_before_seconds=(3 * 3600 if i == 6 else None)))
    return calls


def power_calls(b: Builder, project_name: str, session_uuid: str) -> list[Call]:
    ctx = 6_000
    calls: list[Call] = []
    for i in range(14):
        ctx += b.rng.randint(2_500, 4_500)
        r = i % 5
        if r == 0:
            tool = Tool("Read", {"file_path": b.rng.choice(_POWER_FILES)}, "# demo")
        elif r == 1:
            tool = Tool("Grep", {"pattern": "schema"}, "5 matches (demo)")
        elif r == 2:
            tool = Tool("Edit", {"file_path": b.rng.choice(_POWER_FILES)}, "edit applied (demo)")
        elif r == 3:
            tool = Tool("Bash", {"command": "python -m etl.run --stage all"}, "pipeline ok (demo)")
        else:
            tool = Tool("Agent", {"subagent_type": "general-purpose",
                                  "prompt": "Investigate a demo pipeline stage."},
                        "subagent summary (demo)")
        calls.append(Call(context=ctx, output=b.rng.randint(3_500, 6_000), model=OPUS,
                          text="Coordinating the demo pipeline work.", tools=[tool]))
    return calls


def error_loop_calls(b: Builder, project_name: str, session_uuid: str) -> list[Call]:
    model = b.rng.choice([SONNET, HAIKU])
    ctx = 3_000
    calls: list[Call] = []
    for i in range(4):   # Bash x4 consecutive -> loop_count >= 1 (min_run 3)
        ctx += 1_500
        err = i < 3
        calls.append(Call(ctx, output=b.rng.randint(120, 200), model=model,
                          tools=[Tool("Bash", {"command": "npm test"},
                                      "FAIL: 2 failing (demo)" if err else "PASS (demo)",
                                      is_error=err)]))
    ctx += 1_500
    calls.append(Call(ctx, output=180, model=model,
                      tools=[Tool("Edit", {"file_path": "src/app/fix.ts"}, "edit applied (demo)")]))
    return calls


_FACTORIES = {
    "normal": normal_calls, "reread": reread_calls, "oversized": oversized_calls,
    "late": late_compaction_calls, "stale": stale_calls, "power": power_calls,
    "errloop": error_loop_calls,
}
_PROMPTS = {
    "normal": "Help me tidy up the demo storefront.",
    "reread": "Trace the demo checkout cart module.",
    "oversized": "Export the full demo product catalog and check it.",
    "late": "Do a deep review of the whole demo pipeline.",
    "stale": "Analyze the demo dataset, then a quick follow-up later.",
    "power": "Run and coordinate the demo data pipeline.",
    "errloop": "The demo tests keep failing -- fix them.",
}
_MEMORY = {
    "demo-web-shop": [("checkout-notes", "Checkout flow relies on the demo cart module."),
                      ("perf-log", "Watch bundle size on the demo storefront.")],
    "demo-mobile-app": [("release-notes", "Demo mobile app ships weekly."),
                        ("api-contract", "Demo mobile app talks to the demo API gateway.")],
    "demo-data-pipeline": [("pipeline-runbook", "Demo ETL runs nightly across three stages."),
                           ("data-contract", "Demo warehouse schema is versioned.")],
}
# (project folder, cwd, branch, archetype, count)
_SCHEDULE = [
    ("demo-web-shop", "/home/dev/demo-web-shop", "main", "normal", 9),
    ("demo-web-shop", "/home/dev/demo-web-shop", "main", "reread", 2),
    ("demo-web-shop", "/home/dev/demo-web-shop", "main", "oversized", 2),
    ("demo-web-shop", "/home/dev/demo-web-shop", "main", "late", 2),
    ("demo-web-shop", "/home/dev/demo-web-shop", "main", "stale", 2),
    ("demo-web-shop", "/home/dev/demo-web-shop", "main", "errloop", 3),
    ("demo-mobile-app", "/home/dev/demo-mobile-app", "develop", "normal", 9),
    ("demo-mobile-app", "/home/dev/demo-mobile-app", "develop", "reread", 2),
    ("demo-mobile-app", "/home/dev/demo-mobile-app", "develop", "oversized", 2),
    ("demo-mobile-app", "/home/dev/demo-mobile-app", "develop", "late", 2),
    ("demo-mobile-app", "/home/dev/demo-mobile-app", "develop", "stale", 2),
    ("demo-mobile-app", "/home/dev/demo-mobile-app", "develop", "errloop", 3),
    ("demo-data-pipeline", "/home/dev/demo-data-pipeline", "main", "power", 6),
]


def generate(out_dir: Path, scale: int = 1) -> None:
    out_dir = Path(out_dir)
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    scale = max(1, int(scale))
    # Sessions-only density knob: replicate each archetype `scale` times. Token
    # magnitudes and the ~55-day window are untouched, so every detector still
    # fires -- there are just proportionally more sessions per project and day.
    schedule = [(f, cwd, br, arch, count * scale) for f, cwd, br, arch, count in _SCHEDULE]
    power_total = sum(count for *_, arch, count in schedule if arch == "power")
    power_days = _power_days(power_total)

    rng = random.Random(SEED)
    b = Builder(rng=rng)
    session_no = 0
    power_i = 0
    day = 55
    first_session: dict[str, str] = {}

    for folder, cwd, branch, archetype, count in schedule:
        project_dir = out_dir / folder
        project_dir.mkdir(exist_ok=True)
        for _ in range(count):
            session_no += 1
            session_uuid = _uuid(0x5, session_no)
            first_session.setdefault(folder, session_uuid)
            calls = _FACTORIES[archetype](b, folder, session_uuid)
            if archetype == "power":
                offset = power_days[power_i]
                power_i += 1
            else:
                offset = max(1, day)
                day = day - 1 if day > 1 else 55
            start = REF - timedelta(days=offset, hours=rng.randint(0, 6), minutes=rng.randint(0, 59))
            rows = build_session(b, start, _PROMPTS[archetype], calls, cwd, branch)
            _write_jsonl(project_dir / f"{session_uuid}.jsonl", rows)
            for call in calls:
                for tool in call.tools:
                    if tool.persisted:
                        p = out_dir / tool.persisted
                        p.parent.mkdir(parents=True, exist_ok=True)
                        p.write_text(
                            "[demo] Full synthetic tool output -- content omitted.\n"
                            "This stands in for a large captured result.\n",
                            encoding="utf-8")
            if archetype == "power":
                build_subagents(project_dir, session_uuid, b, rng.randint(4, 5))

    for folder, notes in _MEMORY.items():
        mem = out_dir / folder / "memory"
        mem.mkdir(exist_ok=True)
        for name, body in notes:
            (mem / f"{name}.md").write_text(
                "\n".join(["---", f"name: {name}", "type: note",
                           f"description: {body}",
                           f"originSessionId: {first_session[folder]}", "---",
                           f"{body} All content here is synthetic demo data.\n"]),
                encoding="utf-8")


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent / "claude-export"
    raw_scale = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("CCFR_DEMO_SCALE", "1")
    try:
        scale = max(1, int(raw_scale))
    except ValueError:
        sys.exit(f"invalid scale {raw_scale!r}: expected a positive integer")
    generate(out, scale)
    suffix = f" (scale x{scale})" if scale > 1 else ""
    print(f"Wrote synthetic demo export to {out}{suffix}")


if __name__ == "__main__":
    main()
