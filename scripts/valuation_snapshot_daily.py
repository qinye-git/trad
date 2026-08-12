#!/usr/bin/env python
# valuation_snapshot_daily.py
# 每日估值快照 ETL（复用 valuation.pipeline + common.io）
# 输出: valuation_snapshot_daily.csv

from __future__ import annotations

from datetime import datetime
from pathlib import Path
import sys
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from common.io import load_code_list
from valuation.pipeline import build_industry_maps, fetch_and_update_pepb

SCRIPT_DIR = ROOT
OUT_FILE = SCRIPT_DIR / 'data' / 'cache' / 'valuation_snapshot_daily.csv'
CODES_FILE = SCRIPT_DIR / 'data' / 'input' / 'all_a_codes.txt'


def log(msg: str):
    print(f'[{datetime.now().strftime("%H:%M:%S")}] {msg}', flush=True)


def load_codes(path: Path) -> list[str]:
    return load_code_list(path)


def main():
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    log('===== valuation_snapshot_daily ETL =====')
    codes = load_codes(CODES_FILE)
    if not codes:
        raise SystemExit('all_a_codes.txt 不存在或为空，无法生成估值快照')

    ind1_map, ind2_map = build_industry_maps()
    log(f'股票池: {len(codes)}只，开始增量生成估值快照...')

    # 复用统一增量逻辑（缓存读取 / 缺失抓取 / 行业中位数重算）
    df = fetch_and_update_pepb(codes, ind1_map, ind2_map)

    # 保持旧脚本产物兼容
    pd.DataFrame(df).to_csv(OUT_FILE, index=False, encoding='utf-8-sig')
    log(f'保存完成: {OUT_FILE} ({len(df)}只)')


if __name__ == '__main__':
    main()
