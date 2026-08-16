// 轻量 K 线图：canvas 蜡烛图 + 成交量 + MA5/MA10/MA20，无第三方依赖
// 日K 默认只展示最近 MAX_DAY_BARS 根，避免周期过长导致蜡烛过密不可读
window.DetailChart = (function () {
  const COLORS = {
    up: '#FF5C62',      // A股习惯：红涨
    dn: '#2FE090',
    grid: 'rgba(255,255,255,.06)',
    axis: 'rgba(255,255,255,.38)',
    text: 'rgba(255,255,255,.45)',
    ma5: '#FFC247',
    ma10: '#56B4FF',
    ma20: '#C77DFF',
    volUp: 'rgba(255,92,98,.45)',
    volDn: 'rgba(47,224,144,.45)',
    lastLine: 'rgba(255,194,71,.55)',
  };
  const MAX_DAY_BARS = 120;     // 日K 最多展示根数上限（约半年）
  const DEFAULT_DAY_BARS = 80;   // 日K 默认展示根数（约 4 个月，避免过密）
  const MIN_BARS = 20;           // 缩放边界：最少展示根数
  // 图表状态：canvas -> { rows, period, bars, offset, plotW }；offset 为窗口相对
  // 最右端(最新)向左平移的根数；wheel 改 bars、左键拖动改 offset 后重绘
  const chartState = new WeakMap();
  const boundCanvas = new WeakSet();
  let dragState = null; // 拖动中：{ canvas, startX, startOffset }

  function calcMA(closes, n) {
    const out = new Array(closes.length).fill(null);
    let sum = 0;
    for (let i = 0; i < closes.length; i++) {
      sum += closes[i];
      if (i >= n) sum -= closes[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  // 按价格区间自适应小数位，避免高价股标签溢出
  function fmtPrice(v, maxP) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '--';
    if (maxP >= 1000) return n.toFixed(0);
    if (maxP >= 100) return n.toFixed(1);
    return n.toFixed(2);
  }

  // 单周期可展示根数上限：日K 最多 MAX_DAY_BARS，周/月全量
  function maxLimit(period, rows) {
    return period === 'day' ? Math.min(MAX_DAY_BARS, rows.length) : rows.length;
  }

  function draw(canvas, rows, period, barCount, hoverIndex = -1) {
    if (!canvas || !rows || !rows.length) return;
    const wrap = canvas.parentElement;
    if (!wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(120, wrap.clientWidth || 440);
    const H = Math.max(140, wrap.clientHeight || 280);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // 窗口 = 最近 barCount 根；offset 向左平移以查看历史，两端 clamp 不越界
    const total = rows.length;
    const maxBars = Math.max(MIN_BARS, Math.min(barCount, total));
    const st = chartState.get(canvas) || {};
    const offset = Math.max(0, Math.min(Math.max(0, total - maxBars), st.offset || 0));
    const end = total - offset;
    const start = Math.max(0, end - maxBars);
    const slice = rows.slice(start, end);
    const n = slice.length;

    const isMin = period === 'min';
    // 均线基于全量收盘价计算，再按当前窗口 [start,end) 截取，
    // 保证拖动平移时 MA 与窗口内日期一一对应（分时无 MA）
    let ma5 = [], ma10 = [], ma20 = [];
    if (!isMin) {
      const fullCloses = rows.map(r => r.close);
      ma5 = calcMA(fullCloses, 5).slice(start, end);
      ma10 = calcMA(fullCloses, 10).slice(start, end);
      ma20 = calcMA(fullCloses, 20).slice(start, end);
    }

    const padL = 52, padR = 10, padT = 12, padB = 20, volH = 40, gap = 6;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB - volH - gap;
    if (plotW < 30 || plotH < 20) return;
    // 回写窗口状态（供拖动/缩放复用）
    const stCur = chartState.get(canvas);
    if (stCur) { stCur.offset = offset; stCur.plotW = plotW; }

    let minP = Infinity, maxP = -Infinity, maxV = 0;
    for (const r of slice) {
      if (r.low < minP) minP = r.low;
      if (r.high > maxP) maxP = r.high;
      if (r.volume > maxV) maxV = r.volume;
    }
    if (isMin) {
      // 分时：累计均价与当日开盘价纳入 Y 轴范围
      for (const r of slice) {
        const a = Number(r.avg);
        if (Number.isFinite(a)) {
          if (a < minP) minP = a;
          if (a > maxP) maxP = a;
        }
      }
      const base = Number(slice[0]?.open);
      if (Number.isFinite(base)) {
        if (base < minP) minP = base;
        if (base > maxP) maxP = base;
      }
    } else {
      for (const arr of [ma5, ma10, ma20]) {
        for (const v of arr) {
          if (v == null) continue;
          if (v < minP) minP = v;
          if (v > maxP) maxP = v;
        }
      }
    }
    if (!Number.isFinite(minP) || !Number.isFinite(maxP) || maxP <= minP) { minP = maxP - 1; maxP = maxP + 1; }
    const pad = (maxP - minP) * 0.06;
    minP -= pad; maxP += pad;

    const y = p => padT + plotH - ((p - minP) / (maxP - minP)) * plotH;
    const stepW = plotW / n;
    const candleW = Math.max(2, Math.min(12, stepW * 0.62));
    const x = i => padL + (i + 0.5) * stepW;

    ctx.font = '10px "Segoe UI",sans-serif';

    // 网格 + Y 轴（4 条，标签按价格区间自适应小数位）
    const gridN = 4;
    for (let g = 0; g <= gridN; g++) {
      const yy = padT + (plotH / gridN) * g;
      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, Math.round(yy) + 0.5);
      ctx.lineTo(W - padR, Math.round(yy) + 0.5);
      ctx.stroke();
      const val = maxP - ((maxP - minP) / gridN) * g;
      ctx.fillStyle = COLORS.axis;
      ctx.textAlign = 'right';
      ctx.fillText(fmtPrice(val, maxP), padL - 6, yy + 3);
    }

    const last = slice[n - 1];
    const priceColor = isMin
      ? (last.close >= (Number(slice[0]?.open) || last.close) ? COLORS.up : COLORS.dn)
      : COLORS.up;
    if (isMin) {
      // 分时：基准虚线 + 成交量柱 + 价格线 + 均价线
      const base = Number(slice[0]?.open);
      if (Number.isFinite(base)) {
        const by = y(base);
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = COLORS.axis;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padL, by);
        ctx.lineTo(W - padR, by);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = COLORS.text;
        ctx.textAlign = 'left';
        ctx.fillText(fmtPrice(base, maxP), W - padR - 42, by - 3);
      }
      for (let i = 0; i < n; i++) {
        const r = slice[i];
        const prevC = i > 0 ? slice[i - 1].close : r.open;
        const vh = maxV > 0 ? (r.volume / maxV) * (volH - 4) : 0;
        ctx.fillStyle = r.close >= prevC ? COLORS.volUp : COLORS.volDn;
        ctx.fillRect(x(i) - candleW / 2, padT + plotH + gap + (volH - 2 - vh), candleW, vh);
      }
      const drawLine = (getVal, color, width) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < n; i++) {
          const v = getVal(slice[i]);
          if (v == null) { started = false; continue; }
          const px = x(i), py = y(v);
          if (!started) { ctx.moveTo(px, py); started = true; }
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      };
      drawLine(r => r.close, priceColor, 1.6);   // 价格线
      drawLine(r => r.avg, COLORS.ma10, 1.2);    // 累计均价线
    } else {
      // 蜡烛 + 影线 + 成交量
      for (let i = 0; i < n; i++) {
        const r = slice[i];
        const up = r.close >= r.open;
        const color = up ? COLORS.up : COLORS.dn;
        const cx = x(i);
        const oy = y(r.open), cy = y(r.close);
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx, y(r.high));
        ctx.lineTo(cx, y(r.low));
        ctx.stroke();
        const top = Math.min(oy, cy), bh = Math.max(1, Math.abs(cy - oy));
        ctx.fillRect(cx - candleW / 2, top, candleW, bh);
        if (!up) ctx.strokeRect(cx - candleW / 2, top, candleW, bh);
        const vh = maxV > 0 ? (r.volume / maxV) * (volH - 4) : 0;
        ctx.fillStyle = up ? COLORS.volUp : COLORS.volDn;
        ctx.fillRect(cx - candleW / 2, padT + plotH + gap + (volH - 2 - vh), candleW, vh);
      }

      // MA 均线（MA5 加粗高亮）
      const drawMA = (arr, color, width) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] == null) { started = false; continue; }
          const px = x(i), py = y(arr[i]);
          if (!started) { ctx.moveTo(px, py); started = true; }
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      };
      drawMA(ma5, COLORS.ma5, 1.5);
      drawMA(ma10, COLORS.ma10, 1.1);
      drawMA(ma20, COLORS.ma20, 1.1);
    }

    // 最新价虚线 + 标签
    const ly = y(last.close);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = COLORS.lastLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, ly);
    ctx.lineTo(W - padR, ly);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = COLORS.lastLine;
    ctx.textAlign = 'left';
    ctx.fillText(fmtPrice(last.close, maxP), W - padR - 42, ly - 3);

    // X 轴日期刻度：数量按可用宽度自适应（4~6 个），标签按周期格式化
    const tickCount = Math.max(2, Math.min(6, Math.floor(plotW / 88)));
    const fmtTick = d => {
      const s = String(d);
      if (period === 'month') return s.length >= 7 ? s.slice(0, 7) : s;
      return s.length >= 10 ? s.slice(5) : s; // day/week -> MM-DD
    };
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = 'center';
    for (let t = 0; t < tickCount; t++) {
      const i = Math.round(((n - 1) * t) / (tickCount - 1 || 1));
      ctx.fillText(fmtTick(slice[i]?.date), x(i), H - 7);
    }

    // 图例：VOL + MA5/MA10/MA20 + 数据区间
    let lx = padL;
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = 'left';
    ctx.fillText('VOL', padL, padT + plotH + gap + volH - 6);
    lx += ctx.measureText('VOL').width + 14;
    const legend = isMin
      ? [['价格', priceColor], ['均价', COLORS.ma10]]
      : [['MA5', COLORS.ma5], ['MA10', COLORS.ma10], ['MA20', COLORS.ma20]];
    for (const [name, color] of legend) {
      ctx.fillStyle = color;
      ctx.fillRect(lx, padT + 4, 12, 2);
      ctx.fillText(name, lx + 16, padT + 9);
      lx += 16 + ctx.measureText(name).width + 14;
    }
    const rangeText = slice[0]?.date + ' ~ ' + slice[n - 1]?.date;
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = 'right';
    ctx.fillText(rangeText, W - padR, padT + 9);

    // —— 分时十字线追踪：竖线 + 横线 + 信息框 ——
    if (isMin && hoverIndex >= 0 && hoverIndex < n) {
      const h = slice[hoverIndex];
      const cx = x(hoverIndex), cy = y(h.close);
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(255,255,255,.4)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, padT); ctx.lineTo(cx, padT + plotH + gap + volH); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(padL, cy); ctx.lineTo(W - padR, cy); ctx.stroke();
      ctx.setLineDash([]);

      const base = Number(slice[0]?.open);
      const pct = base > 0 ? (h.close - base) / base * 100 : null;
      const volText = h.volume >= 1e4 ? (h.volume / 1e4).toFixed(1) + '万手' : h.volume.toFixed(0) + '手';
      const info = [
        ['时间', h.date],
        ['价格', h.close.toFixed(2)],
        ['涨跌', pct == null ? '--' : (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%'],
        ['均价', Number(h.avg).toFixed(2)],
        ['量', volText],
      ];
      const boxW = 88, rowH = 14, bpad = 6;
      const boxH = bpad * 2 + info.length * rowH;
      let bx = cx + 12;
      if (bx + boxW > W - padR) bx = cx - boxW - 12;
      let by = cy - boxH / 2;
      by = Math.max(padT, Math.min(padT + plotH - boxH, by));
      ctx.fillStyle = 'rgba(15,17,23,.92)';
      ctx.strokeStyle = 'rgba(255,255,255,.18)';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx, by, boxW, boxH, 4); else ctx.rect(bx, by, boxW, boxH);
      ctx.fill();
      ctx.stroke();
      ctx.font = '10px "Segoe UI",sans-serif';
      info.forEach(([k, v], ri) => {
        const ty = by + bpad + ri * rowH + 10;
        ctx.fillStyle = COLORS.text;
        ctx.textAlign = 'left';
        ctx.fillText(k, bx + 6, ty);
        ctx.fillStyle = '#FFF';
        ctx.textAlign = 'right';
        ctx.fillText(v, bx + boxW - 6, ty);
      });
    }
  }

  // 绑定交互（各只绑定一次）：滚轮缩放 + 左键拖动平移
  function ensureBind(canvas) {
    if (boundCanvas.has(canvas)) return;
    boundCanvas.add(canvas);

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const st = chartState.get(canvas);
      if (!st || !st.rows || !st.rows.length) return;
      const lo = Math.min(MIN_BARS, st.rows.length);
      const hi = maxLimit(st.period, st.rows);
      // 向上滚放大（根数减少），向下滚缩小（根数增多）
      let next = Math.round(st.bars * (e.deltaY > 0 ? 1.12 : 1 / 1.12));
      next = Math.max(lo, Math.min(hi, next));
      if (next === st.bars) return;
      st.bars = next;
      draw(canvas, st.rows, st.period, next, st.hover ?? -1); // offset 由 draw 内 clamp
    }, { passive: false });

    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const st = chartState.get(canvas);
      if (!st || !st.rows || !st.rows.length) return;
      dragState = { canvas, startX: e.clientX, startOffset: st.offset || 0 };
      if (st.hover != null && st.hover >= 0) { st.hover = -1; }
      canvas.style.cursor = 'grabbing';
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragState) return;
      const st = chartState.get(dragState.canvas);
      if (!st || !st.rows || !st.rows.length) return;
      const stepW = Math.max(1, (st.plotW || 300) / st.bars);
      const maxOffset = Math.max(0, st.rows.length - st.bars);
      // 右拖看更早历史（offset 增大），左拖回到最新；两端 clamp
      const off = Math.max(0, Math.min(maxOffset, Math.round(dragState.startOffset + (e.clientX - dragState.startX) / stepW)));
      if (off === st.offset) return;
      st.offset = off;
      draw(dragState.canvas, st.rows, st.period, st.bars, -1);
    });

    window.addEventListener('mouseup', () => {
      if (!dragState) return;
      dragState.canvas.style.cursor = 'grab';
      dragState = null;
    });

    // 分时十字线追踪：鼠标移动吸附最近数据点并重绘
    canvas.addEventListener('mousemove', (e) => {
      if (dragState) return;
      const st = chartState.get(canvas);
      if (!st || !st.rows || !st.rows.length || st.period !== 'min') return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const stepW = Math.max(1, (st.plotW || 300) / st.bars);
      const idx = Math.floor((mx - 52 - stepW / 2) / stepW);
      const inPlot = mx >= 52 && mx <= 52 + (st.plotW || 300);
      const cur = (inPlot && idx >= 0 && idx < st.bars) ? idx : -1;
      if ((st.hover ?? -1) === cur) return;
      st.hover = cur;
      draw(canvas, st.rows, st.period, st.bars, cur);
    });

    canvas.addEventListener('mouseleave', () => {
      const st = chartState.get(canvas);
      if (st && (st.hover ?? -1) >= 0) {
        st.hover = -1;
        draw(canvas, st.rows, st.period, st.bars, -1);
      }
    });
  }

  function render(canvas, rows, period) {
    if (!canvas || !rows || !rows.length) return;
    const hi = maxLimit(period, rows);
    const lo = Math.min(MIN_BARS, rows.length);
    const defaults = period === 'day' ? Math.min(DEFAULT_DAY_BARS, hi) : hi;
    const st = chartState.get(canvas);
    // 已缩放过则保留根数；新数据/新周期回到最新端（offset 归零）
    const bars = st ? Math.max(lo, Math.min(hi, st.bars)) : defaults;
    const keepOffset = st && st.rows === rows && st.period === period;
    chartState.set(canvas, { rows, period, bars, offset: keepOffset ? st.offset : 0, plotW: 0, hover: keepOffset ? (st.hover ?? -1) : -1 });
    ensureBind(canvas);
    draw(canvas, rows, period, bars, keepOffset ? (st.hover ?? -1) : -1);
  }

  return { render };
})();
