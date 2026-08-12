#!/usr/bin/env python
# build_security_master.py
# CLI 入口：证券主数据构建（实现已模块化至 security_master.pipeline）

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from security_master.pipeline import run


if __name__ == '__main__':
    run(ROOT)
