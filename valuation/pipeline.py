#!/usr/bin/env python
# valuation/pipeline.py
# 按需查询指定股票列表的PE/PB，并集成ROE本地缓存
# PE/PB 增量缓存策略：先读已有缓存，只补今日缺失代码，不再每天全量重建
# 单股请求加硬超时（SINGLE_STOCK_TIMEOUT秒），超时直接放弃，不卡死整轮

try:
    import akshare as ak
except ModuleNotFoundError:
    ak = None
import pandas as pd
import concurrent.futures
import time
import os
import sys
import socket
import argparse
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = SCRIPT_DIR / 'data'
INPUT_DIR = DATA_DIR / 'input'
CACHE_DIR = DATA_DIR / 'cache'
INDUSTRY_MAP_FILE = str(INPUT_DIR / 'industry_sw1_map.csv')
ROE_CACHE_FILE    = str(CACHE_DIR / 'roe_snapshot.csv')
PEPB_CACHE_FILE   = str(CACHE_DIR / 'pepb_snapshot_daily.csv')
PEPB_CACHE_PKL    = str(CACHE_DIR / 'pepb_snapshot_daily.pkl')

MAX_WORKERS           = 8    # 降至8线程，减少被限流/卡死概率
MAX_RETRY             = 2    # 重试次数降为2，避免卡死请求长时间阻塞
REQUEST_DELAY         = 0.1  # 每次成功请求后延迟（秒），防止限速
SINGLE_STOCK_TIMEOUT  = 12   # 单股请求硬超时（秒），超时直接放弃

ROE_CACHE_DAYS_NORMAL       = 45
ROE_CACHE_DAYS_REPORT_MONTH = 7
ROE_REPORT_MONTHS           = {4, 8, 10}

def log(msg):
    print(f'[valuation] {msg}', flush=True)

# ─── 行业映射 ────────────────────────────────────────────────────────────
def build_industry_maps():
    ind1, ind2 = {}, {}
    if os.path.exists(INDUSTRY_MAP_FILE):
        df = pd.read_csv(INDUSTRY_MAP_FILE, dtype=str)
        ind1 = dict(zip(df['code'].str.zfill(6), df['industry_l1']))
        if 'industry_l2' in df.columns:
            ind2 = dict(zip(df['code'].str.zfill(6), df['industry_l2']))
    return ind1, ind2

# ─── PE/PB 单股查询（雪球）───────────────────────────────────────────────
def code_to_xq_symbol(code):
    c = str(code).zfill(6)
    if c.startswith(('60', '68', '51', '11')): return 'SH' + c
    elif c.startswith(('00', '30', '12', '15', '16')): return 'SZ' + c
    elif c.startswith(('43', '83', '87', '88')): return 'BJ' + c
    else: return 'SH' + c

def fetch_one_xq(code):
    """
    单股估值查询。通过 socket.setdefaulttimeout 给底层网络请求加真正的超时，
    确保卡死请求在 SINGLE_STOCK_TIMEOUT 秒内被系统级中断，而不只是放弃等待。
    """
    if ak is None:
        return code, '', None, None, 'akshare_missing'
    symbol = code_to_xq_symbol(code)
    old_timeout = socket.getdefaulttimeout()
    socket.setdefaulttimeout(SINGLE_STOCK_TIMEOUT)
    try:
        for attempt in range(MAX_RETRY):
            try:
                df = ak.stock_individual_spot_xq(symbol=symbol)
                row = dict(zip(df['item'], df['value']))
                pe_ttm = row.get('市盈率(TTM)')
                pb     = row.get('市净率')
                name   = row.get('名称', '')
                try: pe_ttm = float(pe_ttm) if pe_ttm is not None else None
                except: pe_ttm = None
                try: pb = float(pb) if pb is not None else None
                except: pb = None
                time.sleep(REQUEST_DELAY)
                return code, name, pe_ttm, pb, None
            except socket.timeout:
                # socket 层超时，直接放弃，不重试
                return code, '', None, None, f'socket_timeout>{SINGLE_STOCK_TIMEOUT}s'
            except Exception as e:
                err_str = str(e)
                if attempt < MAX_RETRY - 1:
                    wait = 1.0 if 'Expecting value' in err_str else 0.3
                    time.sleep(wait * (attempt + 1))
                else:
                    return code, '', None, None, err_str
    finally:
        socket.setdefaulttimeout(old_timeout)
    return code, '', None, None, 'max_retry'

# ─── ROE 缓存管理 ─────────────────────────────────────────────────────────
def needs_roe_update():
    if not os.path.exists(ROE_CACHE_FILE):
        log('ROE缓存不存在，需要初始化')
        return True
    mtime = datetime.fromtimestamp(os.path.getmtime(ROE_CACHE_FILE))
    now = datetime.now()
    days_old = (now - mtime).days
    if now.month in ROE_REPORT_MONTHS and days_old > ROE_CACHE_DAYS_REPORT_MONTH:
        log(f'处于财报披露月({now.month}月)，ROE缓存已{days_old}天，需更新')
        return True
    if days_old > ROE_CACHE_DAYS_NORMAL:
        log(f'ROE缓存已{days_old}天（>{ROE_CACHE_DAYS_NORMAL}天），需更新')
        return True
    try:
        df_roe = pd.read_csv(ROE_CACHE_FILE, dtype={'code': str})
        total  = len(df_roe)
        valid  = df_roe['roe_avg_3y'].notna().sum()
        coverage = (valid / total) if total > 0 else 0

        # 仅把“文件明显损坏/截断”视为残缺：行数异常少，或全量都是空值且缓存已过1天
        # 避免因为数据源本身可得性低（valid偏少）而每次都强制重建
        if total < 1000:
            log(f'ROE缓存行数异常偏少（{total}），视为残缺，触发重建')
            return True
        if valid == 0 and days_old >= 1:
            log(f'ROE缓存全为空值且已{days_old}天，视为残缺，触发重建')
            return True

        log(f'ROE缓存有效（{days_old}天前，{mtime.strftime("%Y-%m-%d")}），有效覆盖: {valid}/{total} ({coverage:.1%})')
    except Exception:
        log(f'ROE缓存有效（{days_old}天前，{mtime.strftime("%Y-%m-%d")}），直接使用')
    return False

def fetch_roe_one(code):
    c = str(code).zfill(6)
    if ak is None:
        return code, None
    try:
        df = ak.stock_financial_analysis_indicator(symbol=c, start_year='2020')
        if df is not None and not df.empty and '净资产收益率(%)' in df.columns:
            annual = df[df['日期'].astype(str).str.endswith('12-31')].copy()
            if len(annual) == 0:
                annual = df
            vals = annual['净资产收益率(%)'].astype(str).str.replace('%', '', regex=False)
            roes = pd.to_numeric(vals, errors='coerce').dropna()
            if len(roes) > 0:
                recent = roes.iloc[-3:] if len(roes) >= 3 else roes
                return code, float(recent.mean()) / 100
    except Exception:
        pass
    try:
        df = ak.stock_financial_abstract_ths(symbol=c, indicator='按年度')
        if df is None or df.empty:
            return code, None
        col = '净资产收益率'
        if col not in df.columns:
            col = '净资产收益率-摊薄'
        if col not in df.columns:
            return code, None
        vals = df[col].astype(str).str.replace('%', '', regex=False)
        roes = pd.to_numeric(vals, errors='coerce').dropna()
        if len(roes) == 0:
            return code, None
        recent = roes.iloc[-3:] if len(roes) >= 3 else roes
        return code, float(recent.mean()) / 100
    except Exception:
        return code, None

def build_roe_cache(all_codes):
    log(f'开始拉取 {len(all_codes)} 只股票ROE（{MAX_WORKERS}线程）...')
    results = {}
    done = 0
    total = len(all_codes)
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        fm = {ex.submit(fetch_roe_one, c): c for c in all_codes}
        for future in concurrent.futures.as_completed(fm):
            code, roe = future.result()
            done += 1
            results[str(code).zfill(6)] = roe
            if done % 200 == 0 or done == total:
                log(f'ROE进度: {done}/{total}')
    df = pd.DataFrame([
        {'code': c, 'roe_avg_3y': v, 'updated': datetime.now().strftime('%Y-%m-%d')}
        for c, v in results.items()
    ])
    df.to_csv(ROE_CACHE_FILE, index=False, encoding='utf-8-sig')
    valid_n = df['roe_avg_3y'].notna().sum()
    log(f'ROE缓存已保存: {ROE_CACHE_FILE} ({len(df)}只, 有效:{valid_n}只)')
    return dict(zip(df['code'], pd.to_numeric(df['roe_avg_3y'], errors='coerce')))

def load_roe_cache():
    if not os.path.exists(ROE_CACHE_FILE):
        return {}
    df = pd.read_csv(ROE_CACHE_FILE, dtype={'code': str})
    df['code'] = df['code'].str.zfill(6)
    df['roe_avg_3y'] = pd.to_numeric(df['roe_avg_3y'], errors='coerce')
    return dict(zip(df['code'], df['roe_avg_3y']))

# ─── PE/PB 增量缓存 ───────────────────────────────────────────────────────
def _pickle_path_of(csv_path):
    """内部快格式缓存路径：与 CSV 同目录、同文件名、.pkl 后缀"""
    return str(Path(str(csv_path)).with_suffix('.pkl'))

def _read_pepb_cache(pkl_file, csv_file):
    """读取PE/PB主缓存：优先 pickle 快格式，损坏/缺失时回退 CSV（一次性迁移）"""
    if os.path.exists(pkl_file):
        try:
            df = pd.read_pickle(pkl_file)
            if df is not None and not df.empty and 'code' in df.columns:
                return df
        except Exception as e:
            log(f'pickle缓存读取失败({e})，回退CSV')
    if os.path.exists(csv_file):
        return pd.read_csv(csv_file, dtype={'code': str})
    raise FileNotFoundError('PE/PB缓存文件不存在')

def _write_pepb_cache(df, pkl_file, csv_file):
    """双写：内部主缓存用 pickle（更快、类型稳定），CSV 保留给外部流程与人工查看"""
    try:
        df.to_pickle(pkl_file)
    except Exception as e:
        log(f'pickle缓存写入失败({e})，仅保留CSV')
    df.to_csv(csv_file, index=False, encoding='utf-8-sig')

def load_pepb_cache():
    """读取PE/PB缓存（优先 pickle 快格式），返回 DataFrame 或 None"""
    if not os.path.exists(PEPB_CACHE_PKL) and not os.path.exists(PEPB_CACHE_FILE):
        return None
    try:
        df = _read_pepb_cache(PEPB_CACHE_PKL, PEPB_CACHE_FILE)
        df['code'] = df['code'].str.zfill(6)
        return df
    except Exception:
        return None

def _recalc_industry_median(df):
    """
    基于整张缓存表重算行业中位数。
    必须在整表（含历史行）上算，才能保证行业基准不因当日只传候选股而偏移。
    """
    df['pe_ttm'] = pd.to_numeric(df['pe_ttm'], errors='coerce')
    df['pb']     = pd.to_numeric(df['pb'],     errors='coerce')

    ind_valid_mask = (
        (df['pe_ttm'] > 0) & (df['pe_ttm'] < 300) &
        (df['industry_l1'].notna()) & (df['industry_l1'].str.strip() != '')
    )
    valid_pe = df[ind_valid_mask]
    if len(valid_pe) > 0:
        ind_med = valid_pe.groupby('industry_l1')['pe_ttm'].median().reset_index()
        ind_med.columns = ['industry_l1', 'pe_industry_median']
        if 'pe_industry_median' in df.columns:
            df = df.drop(columns=['pe_industry_median'])
        df = df.merge(ind_med, on='industry_l1', how='left')
    else:
        df['pe_industry_median'] = None

    no_industry_mask = (
        df['industry_l1'].isna() | (df['industry_l1'].str.strip() == '')
    )
    df.loc[no_industry_mask, 'pe_industry_median'] = None

    df['pe_discount_flag'] = (
        (df['pe_ttm'] > 0) &
        (df['pe_industry_median'].notna()) &
        (df['pe_industry_median'] > 0) &
        (~no_industry_mask) &
        (df['pe_ttm'] <= df['pe_industry_median'] * 0.90)
    ).astype(int)
    df['is_loss'] = (df['pe_ttm'] <= 0).astype(int)
    return df

def fetch_and_update_pepb(target_codes, ind1_map, ind2_map, pepb_cache_path=''):
    """
    增量 PE/PB 更新策略：
    1. 读已有缓存（pepb_snapshot_daily.csv 或 pepb_cache_path）
    2. 找出今日尚未抓取的目标代码
    3. 只对缺失代码发起网络请求
    4. 合并新旧数据，基于全表重算行业中位数（保证行业基准准确）
    5. 写回缓存文件
    返回：只包含 target_codes 行的 DataFrame（附 roe_avg_3y 待主函数填充）
    """
    today = datetime.now().strftime('%Y-%m-%d')
    csv_file = (
        pepb_cache_path
        if pepb_cache_path and os.path.exists(pepb_cache_path)
        else PEPB_CACHE_FILE
    )
    pkl_file = _pickle_path_of(csv_file)

    # ── 步骤1：读已有缓存（优先 pickle 快格式，缺失/损坏时回退 CSV 一次性迁移）──
    existing_df = None
    cached_codes = set()   # 缓存中已有数据的代码（不限日期，文件3天内有效）
    today_cached_codes = set()  # 今日数据（用于精确去重）

    # 判断缓存文件是否在有效期内（3天内修改过 = 数据基本可用，无需全量重抓）
    PEPB_CACHE_MAX_DAYS = 3
    cache_is_fresh = False
    primary_cache = (
        pkl_file if os.path.exists(pkl_file)
        else (csv_file if os.path.exists(csv_file) else '')
    )
    if primary_cache:
        cache_age_days = (datetime.now() - datetime.fromtimestamp(os.path.getmtime(primary_cache))).days
        cache_is_fresh = cache_age_days <= PEPB_CACHE_MAX_DAYS

    if primary_cache:
        try:
            existing_df = _read_pepb_cache(pkl_file, csv_file)
            existing_df['code'] = existing_df['code'].str.zfill(6)
            if 'date' in existing_df.columns:
                today_cached_codes = set(
                    existing_df[existing_df['date'] == today]['code'].tolist()
                )
            # 如果缓存文件足够新（3天内），已有代码无需重抓
            if cache_is_fresh:
                cached_codes = set(existing_df['code'].tolist())
                log(f'PE/PB缓存已读: {len(existing_df)}行，缓存{cache_age_days}天前，今日已有 {len(today_cached_codes)} 只，总有效 {len(cached_codes)} 只')
            else:
                log(f'PE/PB缓存已读: {len(existing_df)}行，缓存{cache_age_days}天前（>{PEPB_CACHE_MAX_DAYS}天），今日重新抓取')
        except Exception as e:
            log(f'读缓存失败({e})，将全量抓取目标代码')
            existing_df = None
            cached_codes = set()
            today_cached_codes = set()

    # ── 步骤2：计算缺失代码 ──
    target_set = set(str(c).zfill(6) for c in target_codes)
    # 优先用 cached_codes（3天内缓存全量），其次 today_cached_codes（今日精确）
    already_have = cached_codes if cached_codes else today_cached_codes
    missing_codes = sorted(target_set - already_have)
    if ak is None:
        log('akshare 未安装，跳过 PE/PB 网络抓取，优先复用现有缓存')
        missing_codes = []
    log(f'目标代码: {len(target_set)} 只，缓存命中: {len(target_set) - len(missing_codes)} 只，需抓取: {len(missing_codes)} 只')

    # ── 步骤2.5：全缓存命中，直接短路 ──
    # 没有需要抓取的代码时，缓存已包含全部目标行：
    # 直接复用缓存中的目标行，跳过合并、行业中位数重算与全量写盘，避免无效 I/O
    if not missing_codes and existing_df is not None and not existing_df.empty:
        if 'pe_industry_median' not in existing_df.columns:
            # 旧格式缓存缺少派生列时，仅内存重算一次（不写盘）
            existing_df = _recalc_industry_median(existing_df)
        # 旧 CSV-only 环境首次全命中时，做一次性迁移写出 pickle（不重算/不重写 CSV）
        if not os.path.exists(pkl_file):
            try:
                existing_df.to_pickle(pkl_file)
            except Exception as e:
                log(f'pickle缓存初始化失败({e})')
        result = existing_df[existing_df['code'].isin(target_set)].copy()
        log(f'全部目标代码命中缓存，直接复用缓存数据（{len(result)}只），跳过合并/重算/写盘')
        return result

    # ── 步骤3：只抓缺失代码 ──
    new_rows = []
    if missing_codes:
        errors = 0
        skipped_dirty = 0
        done = 0
        total = len(missing_codes)
        log(f'开始抓取 {total} 只PE/PB（{MAX_WORKERS}线程，单股超时{SINGLE_STOCK_TIMEOUT}s）...')
        with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
            fm = {ex.submit(fetch_one_xq, c): c for c in missing_codes}
            for future in concurrent.futures.as_completed(fm, timeout=None):
                try:
                    # 每个 future 单独设硬超时，超时视为错误跳过
                    code, name, pe_ttm, pb, err = future.result(timeout=SINGLE_STOCK_TIMEOUT)
                except concurrent.futures.TimeoutError:
                    errors += 1
                    done += 1
                    if done % 100 == 0 or done == total:
                        log(f'  进度: {done}/{total} 错误/超时:{errors} 过滤:{skipped_dirty}')
                    continue
                except Exception as e:
                    errors += 1
                    done += 1
                    continue
                done += 1
                if err:
                    errors += 1
                if done % 100 == 0 or done == total:
                    log(f'  进度: {done}/{total} 错误/超时:{errors} 过滤:{skipped_dirty}')
                c6 = str(code).zfill(6)
                if not name or 'ST' in str(name) or '退' in str(name):
                    skipped_dirty += 1
                    continue
                new_rows.append({
                    'date': today, 'code': c6, 'name': name,
                    'pe_ttm': pe_ttm, 'pb': pb,
                    'industry_l1': ind1_map.get(c6, ''),
                    'industry_l2': ind2_map.get(c6, ''),
                })
        log(f'本次抓取完成: 写入 {len(new_rows)} 只，错误/超时 {errors} 只，过滤 {skipped_dirty} 只')
    else:
        log('全部目标代码今日缓存命中，无需网络请求')

    # ── 步骤4：合并新旧数据 ──
    new_df = pd.DataFrame(new_rows) if new_rows else pd.DataFrame(
        columns=['date', 'code', 'name', 'pe_ttm', 'pb', 'industry_l1', 'industry_l2']
    )

    if existing_df is not None and not existing_df.empty:
        new_codes_today = set(new_df['code'].tolist())
        keep_existing = existing_df[
            ~((existing_df['date'] == today) & (existing_df['code'].isin(new_codes_today)))
        ]
        merged = pd.concat([keep_existing, new_df], ignore_index=True)
    else:
        merged = new_df

    if merged.empty:
        log('警告：合并后数据为空，返回空结果')
        empty = pd.DataFrame(columns=[
            'date', 'code', 'name', 'pe_ttm', 'pb',
            'industry_l1', 'industry_l2', 'pe_industry_median', 'pe_discount_flag', 'is_loss'
        ])
        _write_pepb_cache(empty, pkl_file, csv_file)
        return empty

    # ── 步骤5：基于全表重算行业中位数，双写回缓存（pickle 主 + CSV 副）──
    merged = _recalc_industry_median(merged)
    _write_pepb_cache(merged, pkl_file, csv_file)

    # 缓存质量统计
    today_df = merged[merged['date'] == today]
    n_with_ind = (today_df['industry_l1'].notna() & (today_df['industry_l1'].str.strip() != '')).sum()
    log(f'\n========== PE/PB缓存质量统计（今日新增）==========')
    log(f'今日写入数:           {len(today_df)}')
    log(f'有效行业覆盖数:       {n_with_ind}')
    log(f'有效PE数 (>0):        {(today_df["pe_ttm"] > 0).sum()}')
    log(f'有效PB数 (>0):        {(today_df["pb"] > 0).sum()}')
    log(f'pe_discount_flag=1:   {today_df["pe_discount_flag"].sum()}')
    log(f'缓存总行数:           {len(merged)}')
    log(f'=================================================')

    # 只返回目标代码的行
    result = merged[merged['code'].isin(target_set)].copy()
    return result


# ─── 主函数 ───────────────────────────────────────────────────────────────
def main():
    os.makedirs(INPUT_DIR, exist_ok=True)
    os.makedirs(CACHE_DIR, exist_ok=True)

    parser = argparse.ArgumentParser()
    parser.add_argument('--codes',          default='', help='逗号分隔的股票代码')
    parser.add_argument('--codesFile',      default='', help='股票代码文件，每行一个')
    parser.add_argument('--out',            default=str(CACHE_DIR / 'valuation_snapshot_daily.csv'), help='输出CSV路径')
    parser.add_argument('--pepbCache',      default='', help='指定PE/PB增量缓存路径（供 qscreen_all_a.mjs 传入）')
    parser.add_argument('--skipRoe',        action='store_true', help='跳过ROE（调试用）')
    parser.add_argument('--buildRoeCache',  action='store_true', help='强制重建ROE缓存后退出')
    parser.add_argument('--buildPepbCache', action='store_true', help='强制全量重建PE/PB缓存后退出')
    args = parser.parse_args()

    all_a_file = os.path.join(str(INPUT_DIR), 'all_a_codes.txt')
    def get_all_codes():
        if not os.path.exists(all_a_file):
            log('找不到 all_a_codes.txt，请先运行股票池更新')
            sys.exit(1)
        with open(all_a_file, 'r', encoding='utf-8') as f:
            return [l.strip() for l in f if l.strip() and l.strip().isdigit()]

    ind1_map, ind2_map = build_industry_maps()

    # ── 强制重建模式 ──
    if args.buildRoeCache:
        build_roe_cache(get_all_codes())
        sys.exit(0)
    if args.buildPepbCache:
        all_codes = get_all_codes()
        if os.path.exists(PEPB_CACHE_FILE):
            os.remove(PEPB_CACHE_FILE)
            log('已清除旧缓存，开始全量重建...')
        if os.path.exists(PEPB_CACHE_PKL):
            os.remove(PEPB_CACHE_PKL)
        fetch_and_update_pepb(all_codes, ind1_map, ind2_map)
        sys.exit(0)

    # ── 解析目标代码列表 ──
    codes = []
    if args.codes:
        codes = [c.strip().zfill(6) for c in args.codes.split(',') if c.strip()]
    elif args.codesFile and os.path.exists(args.codesFile):
        with open(args.codesFile, 'r', encoding='utf-8') as f:
            for line in f:
                c = line.strip().split(',')[0].strip()
                if c: codes.append(c.zfill(6))
    if not codes:
        log('无股票代码输入'); sys.exit(1)

    # ── ROE 缓存 ──
    roe_map = {}
    roe_future = None
    roe_executor = None

    if not args.skipRoe:
        if ak is None:
            if os.path.exists(ROE_CACHE_FILE):
                roe_map = load_roe_cache()
                valid_n = sum(1 for v in roe_map.values() if v is not None and str(v) != 'nan')
                log(f'akshare 未安装，复用现有ROE缓存: {valid_n}只有效')
            else:
                log('akshare 未安装，且无ROE缓存，本次跳过ROE')
        else:
            if needs_roe_update():
                all_codes = get_all_codes()
                if not os.path.exists(ROE_CACHE_FILE):
                    # 首次初始化：改为后台异步，不阻塞 PE/PB 抓取
                    # ROE 缺失时用空 map，筛选结果中 ROE 字段为 NaN，不影响主流程
                    log(f'ROE首次初始化，后台拉取 {len(all_codes)} 只（不阻塞主流程）...')
                    roe_executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
                    roe_future = roe_executor.submit(build_roe_cache, all_codes)
                else:
                    roe_map = load_roe_cache()
                    log(f'ROE缓存过期，加载旧缓存({len(roe_map)}只)，后台重建中...')
                    roe_executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
                    roe_future = roe_executor.submit(build_roe_cache, all_codes)
            else:
                roe_map = load_roe_cache()
                valid_n = sum(1 for v in roe_map.values() if v is not None and str(v) != 'nan')
                log(f'ROE缓存命中: {valid_n}只有效')

    log(f'目标股票: {len(codes)} 只')

    # ── PE/PB 增量缓存查询 ──
    pepb_df = fetch_and_update_pepb(
        codes, ind1_map, ind2_map,
        pepb_cache_path=args.pepbCache
    )

    df = pepb_df.copy()
    log(f'PE/PB目标股匹配: {len(df)}/{len(codes)} 只')

    # ── 填充 ROE ──
    df['roe_avg_3y'] = df['code'].map(roe_map)
    df['roe_avg_3y'] = pd.to_numeric(df['roe_avg_3y'], errors='coerce')

    if roe_future is not None:
        if roe_future.done():
            roe_map = roe_future.result()
            df['roe_avg_3y'] = df['code'].map(roe_map)
            df['roe_avg_3y'] = pd.to_numeric(df['roe_avg_3y'], errors='coerce')
            log('ROE后台重建完成，已更新')
        else:
            log('ROE后台重建仍在进行中，使用旧缓存值')
        if roe_executor: roe_executor.shutdown(wait=False)

    out_path = os.path.abspath(args.out)
    df.to_csv(out_path, index=False, encoding='utf-8-sig')
    roe_valid = df['roe_avg_3y'].notna().sum() if 'roe_avg_3y' in df.columns else 0
    log(f'已保存 {out_path} ({len(df)}只)')
    log(f'ROE覆盖: {roe_valid}/{len(df)}只')


if __name__ == '__main__':
    main()
