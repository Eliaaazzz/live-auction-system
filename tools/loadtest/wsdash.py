#!/usr/bin/env python3
"""Live `/metrics` dashboard for the Lumen gateway — the demo capacity panel.

Polls the server's authoritative `/metrics` snapshot and renders a live,
colour-coded panel of the V9 §4.2 SLO gates plus a single headline that turns
green only when the box is genuinely holding the target (default 10,000)
concurrent connections with every latency budget met and the correctness
invariants intact (`seqGapCount == 0`, `backpressureForceClose == 0`).

It is read-only and dependency-free (stdlib `urllib` only), so it runs on a bare
Beijing ECS during a live demo or a Tier-1 evidence run. The server `/metrics`
is the source of truth — this tool only renders it (see issue #231 and
docs/runbooks/beijing-tier1-10k-demo.md).

Usage:
    python3 tools/loadtest/wsdash.py --target http://115.191.76.40
    python3 tools/loadtest/wsdash.py --target http://127.0.0.1:8080 --once
    python3 tools/loadtest/wsdash.py --target ... --json >> metrics.jsonl
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import time
import urllib.request
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    # (label, json path, budget, unit, comparator) — comparator "<" means the
    # value must stay under budget; "==" means it must equal budget exactly.
    # Kept under TYPE_CHECKING so the generic alias is never evaluated at runtime
    # (works on the older Python a bare ECS might ship).
    GateSpec = tuple[str, tuple[str, ...], float, str, str]

LATENCY_GATES: list[GateSpec] = [
    ("ack p95", ("ackLatencyMs", "p95"), 80.0, "ms", "<"),
    ("broadcast p95", ("broadcastLatencyMs", "p95"), 150.0, "ms", "<"),
    ("roomPatch p95", ("roomStatePatchLatencyMs", "p95"), 150.0, "ms", "<"),
    ("catchup p95", ("catchupLatencyMs", "p95"), 1000.0, "ms", "<"),
    ("script p99", ("placeBidScriptTimeMs", "p99"), 5.0, "ms", "<"),
]
INVARIANT_GATES: list[GateSpec] = [
    ("seqGapCount", ("seqGapCount",), 0.0, "", "=="),
    ("backpressureForceClose", ("backpressureForceClose",), 0.0, "", "=="),
]
INFO_FIELDS: list[tuple[str, tuple[str, ...]]] = [
    ("bidsAccepted", ("bidsAccepted",)),
    ("bidsRejected", ("bidsRejected",)),
    ("streamLenMax", ("streamLenMax",)),
]

GREEN, RED, GREY, BOLD, RESET = "\033[32m", "\033[31m", "\033[90m", "\033[1m", "\033[0m"


@dataclass(frozen=True)
class GateRow:
    label: str
    value: float
    has_data: bool
    ok: bool
    budget_text: str
    value_text: str


def dig(snap: dict, path: tuple[str, ...]) -> object:
    """Walk a nested dict path, returning None if any key is missing."""
    cur: object = snap
    for key in path:
        if not isinstance(cur, dict) or key not in cur:
            return None
        cur = cur[key]
    return cur


def histogram_count(snap: dict, path: tuple[str, ...]) -> int:
    """Lifetime sample count for a histogram path (path[0] is the histogram)."""
    hist = snap.get(path[0]) if path else None
    if isinstance(hist, dict):
        try:
            return int(hist.get("count") or 0)
        except (TypeError, ValueError):
            return 0
    return 0


def eval_gate(snap: dict, spec: GateSpec) -> GateRow:
    label, path, budget, unit, cmp = spec
    raw = dig(snap, path)
    is_latency = len(path) == 2  # (histogram, percentile)
    has_data = (not is_latency) or histogram_count(snap, path) > 0
    try:
        value = float(raw) if raw is not None else 0.0
    except (TypeError, ValueError):
        value = 0.0

    if cmp == "==":
        ok = value == budget
        budget_text = f"== {budget:.0f}"
    else:
        # A latency gate with no samples yet is "not failing" — show n/a and do
        # not paint it red. The final READY headline still requires evidence
        # samples for the mandatory bid/fanout lanes via `readiness()`.
        ok = (value < budget) if has_data else True
        budget_text = f"< {budget:.0f}{unit}"

    if is_latency and not has_data:
        value_text = "   n/a"
    elif unit == "ms":
        value_text = f"{value:8.2f}"
    else:
        value_text = f"{value:8.0f}"
    return GateRow(label, value, has_data, ok, budget_text, value_text)


def eval_active(snap: dict, target_conns: int) -> GateRow:
    try:
        value = float(snap.get("activeConns") or 0)
    except (TypeError, ValueError):
        value = 0.0
    ok = value >= target_conns
    return GateRow(
        "activeConns", value, True, ok, f">= {target_conns}", f"{value:8.0f}"
    )


def all_gate_rows(snap: dict, target_conns: int) -> list[GateRow]:
    rows = [eval_active(snap, target_conns)]
    rows += [eval_gate(snap, g) for g in LATENCY_GATES]
    rows += [eval_gate(snap, g) for g in INVARIANT_GATES]
    return rows


def has_required_evidence_samples(snap: dict) -> bool:
    """READY requires real bid and fanout samples, not just empty histograms.

    Optional lanes such as catchup can stay n/a during a clean steady-state hold,
    but a 10k demo should never turn green before at least one bid outcome sample
    and one public fanout/projection sample exist.
    """
    has_ack = histogram_count(snap, ("ackLatencyMs", "p95")) > 0
    has_fanout = (
        histogram_count(snap, ("broadcastLatencyMs", "p95")) > 0
        or histogram_count(snap, ("roomStatePatchLatencyMs", "p95")) > 0
    )
    return has_ack and has_fanout


def readiness(rows: list[GateRow], snap: dict) -> bool:
    """All gates and the required evidence sample lanes must hold for READY."""
    return all(r.ok for r in rows) and has_required_evidence_samples(snap)


def paint(text: str, color: str, enabled: bool) -> str:
    return f"{color}{text}{RESET}" if enabled else text


def render(snap: dict, target_conns: int, color: bool, ts: str) -> str:
    rows = all_gate_rows(snap, target_conns)
    ready = readiness(rows, snap)
    lines: list[str] = []
    head = f" LUMEN /metrics - {target_conns}-conn readiness "
    lines.append(paint(head, BOLD, color))
    lines.append(f" {ts}")
    lines.append("")
    for r in rows:
        mark = "OK " if r.ok else "XX "
        color_code = GREEN if r.ok else RED
        if not r.has_data:
            color_code = GREY
        line = f"  {paint(mark, color_code, color)} {r.label:<24}{r.value_text}   {paint(r.budget_text, GREY, color)}"
        lines.append(line)
    lines.append("")
    info = "   ".join(
        f"{label}={dig(snap, path)}" for label, path in INFO_FIELDS
    )
    lines.append(paint("  " + info, GREY, color))
    if not has_required_evidence_samples(snap):
        lines.append(paint("  waiting for bid outcome + fanout samples before READY", GREY, color))
    lines.append("")
    verdict = f" {target_conns} READY [PASS] " if ready else f" NOT READY [FAIL] (target {target_conns}) "
    lines.append(paint(verdict, (GREEN if ready else RED) + BOLD, color))
    return "\n".join(lines)


def fetch_metrics(target: str, timeout: float = 5.0) -> dict:
    # Guard the scheme: urllib also speaks file://, ftp://, etc. — a mistyped
    # --target should fail loudly, not read a local file as "metrics".
    if not target.lower().startswith(("http://", "https://")):
        raise ValueError(f"--target must be http:// or https://, got: {target!r}")
    url = target.rstrip("/") + "/metrics"
    req = urllib.request.Request(url, headers={"accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - operator-supplied URL
        return json.loads(resp.read().decode())


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--target", default="http://localhost:8080", help="HTTP base URL of the gateway")
    p.add_argument("--interval", type=float, default=2.0, help="poll interval seconds")
    p.add_argument("--target-conns", type=int, default=10_000, help="activeConns goal for the readiness line")
    p.add_argument("--once", action="store_true", help="print one snapshot panel and exit")
    p.add_argument("--json", action="store_true", help="emit one JSON line per poll (no panel) for capture")
    p.add_argument("--no-color", action="store_true", help="disable ANSI colour")
    return p.parse_args(argv)


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    color = (not args.no_color) and sys.stdout.isatty()

    def poll_once() -> bool:
        try:
            snap = fetch_metrics(args.target)
        except Exception as exc:  # noqa: BLE001 - surface any fetch error, keep looping
            if args.json:
                print(json.dumps({"ts": now_iso(), "error": f"{type(exc).__name__}: {str(exc)[:160]}"}))
            else:
                sys.stdout.write("\033[2J\033[H" if color else "")
                print(f"[{now_iso()}] /metrics fetch failed: {type(exc).__name__}: {str(exc)[:160]}")
            return False
        if args.json:
            rows = all_gate_rows(snap, args.target_conns)
            print(json.dumps({"ts": now_iso(), "ready": readiness(rows, snap), "metrics": snap}))
        else:
            if color:
                sys.stdout.write("\033[2J\033[H")  # clear + home
            print(render(snap, args.target_conns, color, now_iso()))
        return True

    if args.once:
        return 0 if poll_once() else 1

    try:
        while True:
            poll_once()
            time.sleep(max(0.25, args.interval))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
