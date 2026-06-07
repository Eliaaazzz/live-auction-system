#!/usr/bin/env python3
"""Gate Locust CSV output for Lumen bidder-only public load runs."""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from typing import Any


def _num(row: dict[str, str], key: str) -> float:
    raw = (row.get(key) or "0").strip()
    if raw == "":
        return 0.0
    try:
        return float(raw)
    except ValueError:
        return 0.0


def _find(rows: list[dict[str, str]], name: str) -> dict[str, str] | None:
    for row in rows:
        if (row.get("Name") or "").strip() == name:
            return row
    return None


def _rows_with_prefix(rows: list[dict[str, str]], prefix: str) -> list[dict[str, str]]:
    return [row for row in rows if (row.get("Name") or "").strip().startswith(prefix)]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stats", required=True, help="Locust *_stats.csv file")
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--max-connect-fail-ratio", type=float, default=0.001)
    parser.add_argument("--max-bid-no-ack", type=int, default=0)
    parser.add_argument("--min-bid-ack", type=int, default=1)
    parser.add_argument("--max-bid-ack-p95-ms", type=float, default=1000.0)
    args = parser.parse_args()

    with open(args.stats, encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))

    checks: list[dict[str, Any]] = []

    def add(name: str, ok: bool, observed: Any, threshold: Any, reason: str = "ok") -> None:
        checks.append(
            {
                "check": name,
                "status": "PASS" if ok else "FAIL",
                "observed": observed,
                "threshold": threshold,
                "reason": reason if ok else reason,
            }
        )

    connect = _find(rows, "connect")
    if connect is None:
        add("connect_row_present", False, "missing", "present", "missing_connect_row")
        connect_count = 0
        connect_fail = 0
    else:
        connect_count = int(_num(connect, "Request Count"))
        connect_fail = int(_num(connect, "Failure Count"))
        ratio = connect_fail / connect_count if connect_count > 0 else 1.0
        add("connect_fail_ratio", ratio <= args.max_connect_fail_ratio, ratio, args.max_connect_fail_ratio)

    bid_ack = _find(rows, "bid_ack")
    if bid_ack is None:
        add("bid_ack_row_present", False, "missing", "present", "missing_bid_ack_row")
        bid_ack_count = 0
        bid_ack_p95 = 0.0
    else:
        bid_ack_count = int(_num(bid_ack, "Request Count"))
        bid_ack_p95 = _num(bid_ack, "95%")
        add("bid_ack_count", bid_ack_count >= args.min_bid_ack, bid_ack_count, args.min_bid_ack)
        add("bid_ack_p95_ms", bid_ack_p95 <= args.max_bid_ack_p95_ms, bid_ack_p95, args.max_bid_ack_p95_ms)

    no_ack_rows = _rows_with_prefix(rows, "bid_no_ack")
    no_ack_count = sum(int(_num(row, "Request Count")) for row in no_ack_rows)
    no_ack_failures = sum(int(_num(row, "Failure Count")) for row in no_ack_rows)
    no_ack_total = max(no_ack_count, no_ack_failures)
    add("bid_no_ack", no_ack_total <= args.max_bid_no_ack, no_ack_total, args.max_bid_no_ack)

    unexpected = sum(int(_num(row, "Request Count")) for row in _rows_with_prefix(rows, "bid_unexpected_response"))
    add("bid_unexpected_response", unexpected == 0, unexpected, 0)

    result = "PASS" if all(row["status"] == "PASS" for row in checks) else "FAIL"
    os.makedirs(args.out_dir, exist_ok=True)
    out_json = os.path.join(args.out_dir, "locust-gate.json")
    out_tsv = os.path.join(args.out_dir, "locust-gate.tsv")
    payload = {
        "result": result,
        "stats": args.stats,
        "connect_count": connect_count,
        "connect_fail": connect_fail,
        "bid_ack_count": bid_ack_count,
        "bid_ack_p95_ms": bid_ack_p95,
        "bid_no_ack": no_ack_total,
        "checks": checks,
    }
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, sort_keys=True)
        f.write("\n")
    with open(out_tsv, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["check", "status", "observed", "threshold", "reason"], delimiter="\t")
        writer.writeheader()
        writer.writerows(checks)
    print(f"result={result}")
    print(f"locust_gate_json={out_json}")
    print(f"locust_gate_tsv={out_tsv}")
    return 0 if result == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
