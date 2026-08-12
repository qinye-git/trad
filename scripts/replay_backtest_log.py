#!/usr/bin/env python3
"""Minimal backtest log replay & validation."""

from __future__ import annotations

import json
from pathlib import Path
from statistics import mean

ROOT = Path(__file__).resolve().parents[1]
LOG_PATH = ROOT / "data" / "logs" / "backtest_daily_log.jsonl"


def load_rows(path: Path):
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s:
            continue
        try:
            rows.append(json.loads(s))
        except Exception:
            continue
    return rows


def validate_row(row: dict):
    # 兼容旧格式：早期日志无 run_mode/timing_ms 字段
    if "trade_date" not in row:
        return False, "trade_date missing"
    if "timing_ms" in row and isinstance(row.get("timing_ms"), dict):
        if "total" in row["timing_ms"]:
            return True, "ok"
        return False, "timing_ms.total missing"
    # 旧格式只要有核心计数字段也算可回放
    if "input_count" in row and "picked_count" in row:
        return True, "ok_legacy"
    return False, "legacy required fields missing"


def compare_latest_speed(rows: list[dict]):
    if len(rows) < 2:
        return None
    latest = rows[-1]
    prev = rows[-2]
    t1 = float((prev.get("timing_ms") or {}).get("total") or 0)
    t2 = float((latest.get("timing_ms") or {}).get("total") or 0)
    if t1 <= 0 or t2 <= 0:
        return None
    faster = t2 < t1
    ratio = (t1 - t2) / t1
    return {
        "prev_total_ms": t1,
        "latest_total_ms": t2,
        "faster": faster,
        "speedup_ratio": ratio,
    }


def main():
    rows = load_rows(LOG_PATH)
    print(f"log_path={LOG_PATH}")
    print(f"rows={len(rows)}")

    if not rows:
        print("status=empty")
        return

    valid = 0
    invalid = 0
    for r in rows:
        ok, _ = validate_row(r)
        if ok:
            valid += 1
        else:
            invalid += 1
    print(f"valid_rows={valid}")
    print(f"invalid_rows={invalid}")

    totals = [float((r.get("timing_ms") or {}).get("total") or 0) for r in rows]
    totals = [x for x in totals if x > 0]
    if totals:
        print(f"avg_total_ms={mean(totals):.2f}")

    speed = compare_latest_speed(rows)
    if speed:
        print(
            "latest_vs_prev="
            f"{speed['latest_total_ms']:.0f}ms vs {speed['prev_total_ms']:.0f}ms, "
            f"faster={speed['faster']}, speedup={speed['speedup_ratio']*100:.2f}%"
        )
    else:
        print("latest_vs_prev=insufficient_data")


if __name__ == "__main__":
    main()
