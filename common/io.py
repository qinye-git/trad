from __future__ import annotations

from pathlib import Path


def load_code_list(path: str | Path) -> list[str]:
    p = Path(path)
    if not p.exists():
        return []
    codes: list[str] = []
    with p.open('r', encoding='utf-8') as f:
        for line in f:
            s = line.strip().split(',')[0].strip()
            if s.isdigit():
                codes.append(s.zfill(6))
    return list(dict.fromkeys(codes))


def write_code_list(path: str | Path, codes: list[str]) -> None:
    p = Path(path)
    p.write_text('\n'.join(codes) + ('\n' if codes else ''), encoding='utf-8')
