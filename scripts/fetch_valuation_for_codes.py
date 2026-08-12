#!/usr/bin/env python
# fetch_valuation_for_codes.py
# CLI 入口：估值拉取（实现已模块化至 valuation.pipeline）

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from valuation.pipeline import (
    build_industry_maps,
    fetch_and_update_pepb,
    needs_roe_update,
    build_roe_cache,
    load_roe_cache,
    main,
)

__all__ = [
    "build_industry_maps",
    "fetch_and_update_pepb",
    "needs_roe_update",
    "build_roe_cache",
    "load_roe_cache",
    "main",
]


if __name__ == '__main__':
    main()
