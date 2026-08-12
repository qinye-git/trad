from __future__ import annotations

import concurrent.futures
import time
import urllib.request
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

try:
    import akshare as ak
except ModuleNotFoundError:
    ak = None
import pandas as pd


@dataclass(frozen=True)
class SecurityMasterConfig:
    script_dir: Path
    out_csv: Path
    out_txt: Path
    max_workers: int = 16
    valid_code_pattern: str = r'^[036]\d{5}$'
    bad_name_keywords: tuple[str, ...] = ('ST', '退')


def log(msg: str):
    print(f'[security_master] {msg}', flush=True)


def is_clean_name(name: str, bad_keywords: tuple[str, ...]) -> bool:
    if not name or not isinstance(name, str):
        return False
    s = name.strip()
    if not s or s == '-' or s.replace('.', '').isdigit():
        return False
    for kw in bad_keywords:
        if kw in s:
            return False
    return True


def fetch_ak_code_name() -> pd.DataFrame | None:
    if ak is None:
        log('源1 AkShare 不可用（未安装 akshare），跳过')
        return None
    try:
        log('源1 AkShare 证券列表 (stock_info_a_code_name)...')
        df = ak.stock_info_a_code_name()
        if df is None or df.empty:
            return None

        rename = {}
        for col in df.columns:
            cl = col.strip()
            if cl in ('股票代码', '代码', 'code'):
                rename[col] = 'code'
            elif cl in ('股票简称', '名称', '股票名称', 'name'):
                rename[col] = 'name'
        df = df.rename(columns=rename)

        if 'code' not in df.columns or 'name' not in df.columns:
            log(f'源1 字段不匹配: {list(df.columns)}')
            return None

        df['code'] = df['code'].astype(str).str.zfill(6)
        df['name'] = df['name'].astype(str).str.strip()
        df['source'] = 'ak_code_name'
        log(f'源1 返回 {len(df)} 条')
        return df[['code', 'name', 'source']]
    except Exception as e:
        log(f'源1 失败: {e}')
        return None


def to_sina_symbol(code: str) -> str:
    c = str(code).zfill(6)
    return ('sh' if c.startswith(('6', '9')) else 'sz') + c


def sina_batch(codes: list[str], bad_keywords: tuple[str, ...]) -> list[dict]:
    symbols = ','.join(to_sina_symbol(c) for c in codes)
    url = f'https://hq.sinajs.cn/rn={int(time.time())}&list={symbols}'

    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={
                'Referer': 'https://finance.sina.com.cn/',
                'User-Agent': 'Mozilla/5.0',
            })
            with urllib.request.urlopen(req, timeout=15) as r:
                raw = r.read()
            try:
                text = raw.decode('gbk')
            except Exception:
                text = raw.decode('utf-8', errors='replace')

            results = []
            for m in re.finditer(r'hq_str_s[hz](\d{6})="([^"]*?)"', text):
                code_m, body = m.group(1), m.group(2)
                parts = body.split(',')
                name = parts[0].strip() if parts else ''
                if is_clean_name(name, bad_keywords):
                    results.append({'code': code_m, 'name': name, 'source': 'sina'})
            return results
        except Exception:
            if attempt < 2:
                time.sleep(0.5 * (attempt + 1))

    return []


def fetch_sina_snapshot(all_codes: list[str], cfg: SecurityMasterConfig) -> pd.DataFrame | None:
    log(f'源2 新浪批量快照（{cfg.max_workers}线程，{len(all_codes)}只）...')
    batch_size = 100
    batches = [all_codes[i:i + batch_size] for i in range(0, len(all_codes), batch_size)]

    results: list[dict] = []
    done = 0
    total = len(batches)

    with concurrent.futures.ThreadPoolExecutor(max_workers=cfg.max_workers) as ex:
        futs = {ex.submit(sina_batch, b, cfg.bad_name_keywords): b for b in batches}
        for fut in concurrent.futures.as_completed(futs):
            done += 1
            try:
                results.extend(fut.result())
            except Exception:
                pass
            if done % 20 == 0 or done == total:
                log(f'  新浪进度: {done}/{total} 批次，已获取 {len(results)} 只')

    if not results:
        log('源2 新浪快照无结果')
        return None

    df = pd.DataFrame(results)
    df['code'] = df['code'].astype(str).str.zfill(6)
    df['name'] = df['name'].astype(str).str.strip()
    log(f'源2 新浪快照返回 {len(df)} 条')
    return df[['code', 'name', 'source']]


def gen_candidate_codes() -> list[str]:
    codes = set()
    for p in [600, 601, 603, 605]:
        for i in range(1000):
            codes.add(str(p * 1000 + i).zfill(6))
    for i in range(1000):
        codes.add(str(688000 + i).zfill(6))
    for i in range(2000):
        codes.add(str(i).zfill(6))
    for i in range(2000):
        codes.add(str(300000 + i).zfill(6))
    return sorted(codes)


def merge_sources(dfs: list[pd.DataFrame]) -> pd.DataFrame:
    source_priority = {'ak_code_name': 0, 'sina': 1}
    combined = pd.concat([d for d in dfs if d is not None and not d.empty], ignore_index=True)
    if combined.empty:
        return combined
    combined['_prio'] = combined['source'].map(source_priority).fillna(9)
    combined = combined.sort_values('_prio').drop_duplicates(subset='code', keep='first')
    return combined.drop(columns=['_prio']).reset_index(drop=True)


def build_master(df: pd.DataFrame, cfg: SecurityMasterConfig) -> pd.DataFrame:
    total_raw = len(df)
    mask_code = df['code'].str.match(cfg.valid_code_pattern)
    df = df[mask_code].copy()
    n_after_code = len(df)

    mask_name = df['name'].apply(lambda x: is_clean_name(x, cfg.bad_name_keywords))
    n_dirty = (~mask_name).sum()
    df = df[mask_name].copy()

    df = df.drop_duplicates(subset='code', keep='first').reset_index(drop=True)
    df['updated'] = datetime.now().strftime('%Y-%m-%d')

    log('\n========== 证券主数据质量统计 ==========')
    log(f'原始条数（多源合并）: {total_raw}')
    log(f'代码格式过滤后:       {n_after_code}')
    log(f'ST/退市 过滤数:       {n_dirty}')
    log(f'去重后最终数量:       {len(df)}')
    log(f'来源分布:             {df["source"].value_counts().to_dict()}')
    log('==========================================')
    return df


def run(script_dir: Path | None = None):
    script_dir = script_dir or Path(__file__).resolve().parents[1]
    data_input = script_dir / 'data' / 'input'
    data_input.mkdir(parents=True, exist_ok=True)
    cfg = SecurityMasterConfig(
        script_dir=script_dir,
        out_csv=data_input / 'security_master.csv',
        out_txt=data_input / 'all_a_codes.txt',
    )

    log('开始构建证券主数据 security_master.csv（已移除东方财富源）...')
    t0 = time.time()

    r1 = fetch_ak_code_name()
    dfs = []
    if r1 is not None and len(r1) > 1000:
        dfs.append(r1)
        base_codes = r1['code'].str.zfill(6).tolist()
        log(f'基础代码池来自源1，{len(r1)} 只')
    else:
        log('源1失败，使用穷举候选代码池')
        base_codes = gen_candidate_codes()

    sina_df = fetch_sina_snapshot(base_codes, cfg)
    if sina_df is not None and len(sina_df) > 100:
        dfs.append(sina_df)
        log(f'新浪校验完成，有效 {len(sina_df)} 只')
    else:
        log('新浪快照失败或结果不足，跳过交叉校验')

    if not dfs:
        log('所有数据源均失败，退出')
        raise SystemExit(1)

    merged = merge_sources(dfs)
    log(f'多源合并后: {len(merged)} 条')

    master = build_master(merged, cfg)
    if len(master) < 100:
        log(f'警告：最终证券数量过少（{len(master)}），不覆盖已有文件')
        raise SystemExit(1)

    master.to_csv(cfg.out_csv, index=False, encoding='utf-8-sig')
    log(f'已写入: {cfg.out_csv} ({len(master)} 只)')

    codes = master['code'].sort_values().tolist()
    cfg.out_txt.write_text('\n'.join(codes) + '\n', encoding='utf-8')
    log(f'已更新: {cfg.out_txt} ({len(codes)} 只)')

    st_check = master[master['name'].str.contains('ST|退', na=False)]
    if len(st_check) > 0:
        log(f'\n警告：仍有 {len(st_check)} 条含 ST/退 字样:')
        for _, row in st_check.iterrows():
            log(f'  {row["code"]}  {row["name"]}')
    else:
        log('\n二次校验通过：无 ST/退 残留')

    log(f'\n总耗时: {time.time() - t0:.1f}秒')
