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
  const MAX_DAY_BARS = 120; // 日K 最多展示根数（约半年）

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

  function render(canvas, rows, period) {
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

    // 日K 截取最近一段，周/月全量
    const maxBars = period === 'day' ? MAX_DAY_BARS : rows.length;
    const slice = rows.length > maxBars ? rows.slice(-maxBars) : rows;
    const n = slice.length;

    // 均线基于全量收盘价计算再截取，保证窗口第一根就有 MA20 值
    const fullCloses = rows.map(r => r.close);
    const ma5 = calcMA(fullCloses, 5).slice(-n);
    const ma10 = calcMA(fullCloses, 10).slice(-n);
    const ma20 = calcMA(fullCloses, 20).slice(-n);

    const padL = 52, padR = 10, padT = 12, padB = 20, volH = 40, gap = 6;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB - volH - gap;
    if (plotW < 30 || plotH < 20) return;

    let minP = Infinity, maxP = -Infinity, maxV = 0;
    for (const r of slice) {
      if (r.low < minP) minP = r.low;
      if (r.high > maxP) maxP = r.high;
      if (r.volume > maxV) maxV = r.volume;
    }
    for (const arr of [ma5, ma10, ma20]) {
      for (const v of arr) {
        if (v == null) continue;
        if (v < minP) minP = v;
        if (v > maxP) maxP = v;
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

    // 最新价虚线 + 标签
    const last = slice[n - 1];
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
    const legend = [['MA5', COLORS.ma5], ['MA10', COLORS.ma10], ['MA20', COLORS.ma20]];
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
  }

  return { render };
})();
