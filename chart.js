(function(){
  "use strict";


  const COLORS = {
    up: '#17D68C', down: '#FF5470',
    upSoft: 'rgba(23,214,140,0.18)', downSoft: 'rgba(255,84,112,0.18)',
    upBorder: 'rgba(23,214,140,0.55)', downBorder: 'rgba(255,84,112,0.55)',
    grid: 'rgba(255,255,255,0.05)',
    gridStrong: 'rgba(255,255,255,0.09)',
    axisText: '#6b7280',
    crosshair: 'rgba(255,255,255,0.28)',
    crosshairDot: '#fff',
    accent: '#5A87FF',
    bg: '#0B0E14',
    bgTop: '#0D1119',
    axisBg: '#11151F',
    chipBg: 'rgba(17,21,31,0.96)',
    chipBorder: 'rgba(255,255,255,0.08)',
    chipText: '#c7cad2',
    daySeparator: 'rgba(255,255,255,0.10)'
  };


  /* Шрифты берём из CSS-переменных один раз, а не на каждый кадр через getComputedStyle —
       раньше это вызывалось десятки раз за отрисовку и лишний раз нагружало layout/style. */
  const ROOT_STYLE = getComputedStyle(document.documentElement);
  const FONT_MONO = (ROOT_STYLE.getPropertyValue('--mono') || 'ui-monospace, monospace').trim() || 'ui-monospace, monospace';
  const F_AXIS = '11px ' + FONT_MONO;
  const F_AXIS_SEMI = '600 11px ' + FONT_MONO;
  const F_STAT = '11px ' + FONT_MONO;
  const F_STAT_TITLE = '600 13px ' + FONT_MONO;


  const AXIS_W = 74;
  const TIME_AXIS_H = 26;
  const VOL_FRAC = 0.20;
  const PAD_TOP = 14;
  const PAD_BOTTOM = 10;
  const DEFAULT_LIMIT = 1000;


  const state = {
    symbol: 'BTCUSDT',
    interval: '1m',
    candles: [],
    candleWidth: 28,
    offset: 0,
    limit: DEFAULT_LIMIT,
    ws: null,
    wsToken: 0,
    lastTradePrice: null,
    ticker24h: null,
    mouse: {x:null, y:null, inChart:false},
    dragging:false, dragStartX:0, dragStartY:0, dragStartOffset:0, dragStartPriceRange:null, didDrag:false,
    axisDragging:false, axisDragStartY:0, axisDragBaseRange:null,
    manualPriceRange: null,
    shiftDown:false,
    measureToolActive:false,
    pendingMeasurement:null,
    measurements:[],
    hoverIndex:null,
    historyLoading:false
  };


  const canvas = document.getElementById('chartCanvas');
  const ctx = canvas.getContext('2d');
  const wrap = document.getElementById('chart-wrap');
  const loadingOverlay = document.getElementById('loadingOverlay');
  const lastPriceEl = document.getElementById('lastPrice');
  const pctChangeEl = document.getElementById('pctChange');
  const connDot = document.getElementById('connDot');
  const symbolInput = document.getElementById('symbolInput');
  const ohlcO = document.getElementById('ohlcO');
  const ohlcH = document.getElementById('ohlcH');
  const ohlcL = document.getElementById('ohlcL');
  const ohlcC = document.getElementById('ohlcC');
  const ohlcV = document.getElementById('ohlcV');


  let cssW = 0, cssH = 0;


  function decimalsForPrice(p){
    if(p >= 1000) return 2;
    if(p >= 100) return 2;
    if(p >= 1) return 4;
    if(p >= 0.01) return 6;
    return 8;
  }
  function fmtPrice(p){
    if(p == null || isNaN(p)) return '—';
    const d = decimalsForPrice(Math.abs(p));
    return p.toLocaleString('en-US', {minimumFractionDigits:d, maximumFractionDigits:d});
  }
  function fmtVol(v){
    if(v == null || isNaN(v)) return '—';
    if(v >= 1e9) return (v/1e9).toFixed(2)+'B';
    if(v >= 1e6) return (v/1e6).toFixed(2)+'M';
    if(v >= 1e3) return (v/1e3).toFixed(2)+'K';
    return v.toFixed(2);
  }
  function fmtPct(p){
    if(p == null || isNaN(p)) return '—';
    return (p>=0?'+':'') + p.toFixed(2) + '%';
  }
  function niceStep(range, targetTicks){
    if(range <= 0) return 1;
    const raw = range/targetTicks;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw/mag;
    let step;
    if(norm < 1.5) step = 1;
    else if(norm < 3) step = 2;
    else if(norm < 7) step = 5;
    else step = 10;
    return step*mag;
  }
  const INTERVAL_MS = {
    '1m':60e3,'3m':180e3,'5m':300e3,'15m':900e3,'30m':1800e3,
    '1h':3600e3,'2h':7200e3,'4h':14400e3,'6h':21600e3,'8h':28800e3,
    '12h':43200e3,'1d':86400e3,'3d':259200e3,'1w':604800e3
  };
  function fmtTimeAxis(ts, interval){
    const d = new Date(ts);
    const msPerBar = INTERVAL_MS[interval] || 60e3;
    const day = d.getDate().toString().padStart(2,'0');
    const month = (d.getMonth()+1).toString().padStart(2,'0');
    if(msPerBar >= 86400e3){
      return day+'.'+month;
    }
    const hh = d.getHours().toString().padStart(2,'0');
    const mm = d.getMinutes().toString().padStart(2,'0');
    if (hh === '00' && mm === '00') {
      return day+'.'+month;
    }
    return hh+':'+mm;
  }


  function fitCanvas(){
    const rect = wrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    cssW = rect.width; cssH = rect.height;
    canvas.width = Math.round(cssW*dpr);
    canvas.height = Math.round(cssH*dpr);
    canvas.style.width = cssW+'px';
    canvas.style.height = cssH+'px';
    ctx.setTransform(dpr,0,0,dpr,0,0);
    draw();
  }
  window.addEventListener('resize', fitCanvas);


  function layout(){
    const chartW = cssW - AXIS_W;
    const mainH = (cssH - TIME_AXIS_H) * (1 - VOL_FRAC);
    const volTop = mainH + 4;
    const volH = (cssH - TIME_AXIS_H) - mainH - 4;
    return {chartW, mainH, volTop, volH};
  }


  function maxFutureCandles(){
    const {chartW} = layout();
    const visibleCount = Math.ceil(chartW/state.candleWidth) + 2;
    return Math.floor(visibleCount*0.7);
  }


  function visibleRange(){
    const {chartW} = layout();
    const slot = state.candleWidth;
    const n = state.candles.length;
    if(n === 0) return {rightIdx:-1, leftIdx:-1, slot};
    const visibleCount = Math.ceil(chartW/slot) + 2;
    const maxFuture = maxFutureCandles();
    let rightIdx = n - 1 - state.offset;
    rightIdx = Math.max(-maxFuture, Math.min(n-1+maxFuture, rightIdx));
    const leftIdx = rightIdx - visibleCount + 1;
    return {rightIdx, leftIdx, slot};
  }


  function indexToX(i){
    const {chartW} = layout();
    const {rightIdx, slot} = visibleRange();
    const distFromRight = rightIdx - i;
    return chartW - distFromRight*slot - slot/2;
  }
  function xToIndex(x){
    const {chartW} = layout();
    const {rightIdx, slot} = visibleRange();
    const distFromRight = (chartW - x)/slot;
    return Math.round(rightIdx - distFromRight + 0.5);
  }


  function clampScale(s){ return Math.max(0.04, Math.min(25, s)); }


  function autoPriceExtent(){
    const n = state.candles.length;
    if(n === 0) return {min:0,max:1};
    const {leftIdx, rightIdx} = visibleRange();
    const lo = Math.max(0, leftIdx), hi = Math.min(n-1, rightIdx);
    let min = Infinity, max = -Infinity;
    for(let i=lo;i<=hi;i++){
      const c = state.candles[i];
      if(!c) continue;
      if(c.l < min) min = c.l;
      if(c.h > max) max = c.h;
    }
    if(!isFinite(min) || !isFinite(max)){
      const fLo = Math.max(0, n-20);
      for(let i=fLo;i<n;i++){
        const c = state.candles[i];
        if(c.l < min) min = c.l;
        if(c.h > max) max = c.h;
      }
    }
    if(!isFinite(min) || !isFinite(max)){ min=0; max=1; }
    if(min === max){ min *= 0.995; max *= 1.005; }
    const pad = (max-min)*0.08;
    return {min: min-pad, max: max+pad};
  }


  function priceExtent(){
    if(state.manualPriceRange) return state.manualPriceRange;
    return autoPriceExtent();
  }
  function volExtent(){
    const n = state.candles.length;
    if(n === 0) return {max:1};
    const {leftIdx, rightIdx} = visibleRange();
    const lo = Math.max(0, leftIdx), hi = Math.min(n-1, rightIdx);
    let max = 0;
    for(let i=lo;i<=hi;i++){
      const c = state.candles[i];
      if(c && c.v > max) max = c.v;
    }
    return {max: max || 1};
  }


  function priceToY(p, ext){
    const {mainH} = layout();
    const usable = mainH - PAD_TOP - PAD_BOTTOM;
    return PAD_TOP + (ext.max - p)/(ext.max - ext.min) * usable;
  }
  function yToPrice(y, ext){
    const {mainH} = layout();
    const usable = mainH - PAD_TOP - PAD_BOTTOM;
    const t = (y - PAD_TOP)/usable;
    return ext.max - t*(ext.max-ext.min);
  }
  function volToY(v, ext){
    const {volTop, volH} = layout();
    return volTop + volH - (v/ext.max)*volH*0.92;
  }


  function draw(){
    ctx.clearRect(0,0,cssW,cssH);
    const bgGrad = ctx.createLinearGradient(0,0,0,cssH);
    bgGrad.addColorStop(0, COLORS.bgTop);
    bgGrad.addColorStop(1, COLORS.bg);
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0,0,cssW,cssH);


    if(state.candles.length === 0) return;


    const {chartW, mainH, volTop, volH} = layout();
    const {leftIdx, rightIdx, slot} = visibleRange();
    const pExt = priceExtent();
    const vExt = volExtent();


    drawPriceGrid(pExt, chartW, mainH);
    drawVolumeAxisLine(volTop, volH, chartW);
    drawCandles(leftIdx, rightIdx, pExt, slot, chartW);
    drawDaySeparators(leftIdx, rightIdx, chartW, 0, volTop+volH);
    drawVolumeBars(leftIdx, rightIdx, vExt, slot);
    drawTimeAxis(leftIdx, rightIdx, chartW);
    drawLivePriceLine(pExt, chartW);
    drawMeasurement(pExt, chartW, mainH);
    drawCrosshair(pExt, vExt, chartW, mainH, volTop, volH);


    updateOhlcStrip(pExt);


    if (leftIdx < 20 && !state.historyLoading && state.candles.length > 0) {
      loadMoreHistory();
    }
  }


  function drawPriceGrid(ext, chartW, mainH){
    const step = niceStep(ext.max-ext.min, 5);
    const start = Math.ceil(ext.min/step)*step;
    ctx.save();
    ctx.font = F_AXIS;
    ctx.textBaseline = 'middle';
    for(let p = start; p <= ext.max; p += step){
      const y = Math.round(priceToY(p, ext)) + 0.5;
      if(y < 0 || y > mainH) continue;
      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(chartW, y);
      ctx.stroke();


      ctx.fillStyle = COLORS.axisText;
      ctx.textAlign = 'left';
      ctx.fillText(fmtPrice(p), chartW+8, y);
    }
    ctx.strokeStyle = COLORS.gridStrong;
    ctx.beginPath();
    ctx.moveTo(Math.round(chartW)+0.5, 0);
    ctx.lineTo(Math.round(chartW)+0.5, mainH);
    ctx.stroke();
    ctx.restore();
  }


  function drawVolumeAxisLine(volTop, volH, chartW){
    ctx.save();
    ctx.strokeStyle = COLORS.grid;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(volTop)+0.5);
    ctx.lineTo(chartW, Math.round(volTop)+0.5);
    ctx.stroke();
    ctx.restore();
  }


  function drawCandles(leftIdx, rightIdx, ext, slot, chartW){
    const bodyW = Math.max(2, Math.round(slot*0.76));
    const wickW = slot >= 10 ? 1.25 : 1;
    ctx.save();
    ctx.lineCap = 'round';
    for(let i=leftIdx;i<=rightIdx;i++){
      const c = state.candles[i];
      if(!c) continue;
      const x = Math.round(indexToX(i));
      if(x < -slot || x > chartW+slot) continue;
      const up = c.c >= c.o;
      const color = up ? COLORS.up : COLORS.down;
      const border = up ? COLORS.upBorder : COLORS.downBorder;
      const oy = priceToY(c.o, ext);
      const cy = priceToY(c.c, ext);
      const hy = priceToY(c.h, ext);
      const ly = priceToY(c.l, ext);


      ctx.strokeStyle = color;
      ctx.lineWidth = wickW;
      ctx.beginPath();
      ctx.moveTo(x+0.5, hy);
      ctx.lineTo(x+0.5, ly);
      ctx.stroke();


      const top = Math.min(oy,cy);
      const h = Math.max(1, Math.abs(cy-oy));
      const left = Math.round(x - bodyW/2) + 0.5;
      ctx.fillStyle = color;
      ctx.fillRect(left, top, bodyW-1, h);
      if(bodyW > 3){
        ctx.strokeStyle = border;
        ctx.lineWidth = 1;
        ctx.strokeRect(left, Math.round(top)+0.5, bodyW-1, Math.max(1,Math.round(h)-1));
      }
    }
    ctx.restore();
  }


  function drawDaySeparators(leftIdx, rightIdx, chartW, topY, bottomY){
    if(state.candles.length < 2) return;
    ctx.save();
    ctx.strokeStyle = COLORS.daySeparator;
    ctx.lineWidth = 1;
    ctx.setLineDash([4,4]);
    for(let i=leftIdx;i<=rightIdx;i++){
      const c = state.candles[i];
      if(!c) continue;
      const d = new Date(c.t);
      if(i > 0){
        const prev = state.candles[i-1];
        if(prev && new Date(prev.t).getDate() !== d.getDate()){
          const x = Math.round(indexToX(i)) + 0.5;
          ctx.beginPath();
          ctx.moveTo(x, topY);
          ctx.lineTo(x, bottomY);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }


  function drawVolumeBars(leftIdx, rightIdx, ext, slot){
    const {volTop, volH} = layout();
    const bodyW = Math.max(2, Math.round(slot*0.76));
    const r = Math.min(2, bodyW/3);
    for(let i=leftIdx;i<=rightIdx;i++){
      const c = state.candles[i];
      if(!c) continue;
      const x = Math.round(indexToX(i));
      const up = c.c >= c.o;
      ctx.fillStyle = up ? COLORS.upSoft : COLORS.downSoft;
      const y = volToY(c.v, ext);
      const h = (volTop+volH) - y;
      if(h <= r*2){ ctx.fillRect(x - bodyW/2, y, bodyW, h); continue; }
      roundRectTop(ctx, x - bodyW/2, y, bodyW, h, r);
      ctx.fill();
    }
  }
  function roundRectTop(ctx,x,y,w,h,r){
    ctx.beginPath();
    ctx.moveTo(x, y+h);
    ctx.lineTo(x, y+r);
    ctx.arcTo(x, y, x+r, y, r);
    ctx.lineTo(x+w-r, y);
    ctx.arcTo(x+w, y, x+w, y+r, r);
    ctx.lineTo(x+w, y+h);
    ctx.closePath();
  }


  function drawTimeAxis(leftIdx, rightIdx, chartW){
    const {mainH} = layout();
    const slot = state.candleWidth;
    const minLabelGap = 84;
    const step = Math.max(1, Math.ceil(minLabelGap/slot));
    ctx.save();
    ctx.font = F_AXIS;
    ctx.fillStyle = COLORS.axisText;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for(let i=leftIdx;i<=rightIdx;i+=step){
      const c = state.candles[i];
      if(!c) continue;
      const x = Math.round(indexToX(i));
      if(x < 20 || x > chartW-20) continue;
      ctx.fillText(fmtTimeAxis(c.t, state.interval), x, cssH-TIME_AXIS_H+7);
    }
    ctx.restore();
  }


  function drawLivePriceLine(ext, chartW){
    const last = state.candles[state.candles.length-1];
    if(!last) return;
    const price = state.lastTradePrice != null ? state.lastTradePrice : last.c;
    if(price < ext.min || price > ext.max) return;
    const y = Math.round(priceToY(price, ext)) + 0.5;
    const up = price >= last.o;
    const color = up ? COLORS.up : COLORS.down;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.55;
    ctx.setLineDash([3,3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(chartW, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;


    const label = fmtPrice(price);
    ctx.font = F_AXIS_SEMI;
    const tw = ctx.measureText(label).width;
    const w = Math.max(AXIS_W, tw+16);


    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 6;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(chartW, y);
    ctx.lineTo(chartW+5, y-6);
    ctx.lineTo(chartW+w, y-9);
    ctx.lineTo(chartW+w, y+9);
    ctx.lineTo(chartW+5, y+6);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;


    ctx.fillStyle = '#08090b';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, chartW+11, y+0.5);
    ctx.restore();
  }


  function drawCrosshair(pExt, vExt, chartW, mainH, volTop, volH){
    if(!state.mouse.inChart || state.mouse.x == null) return;
    if(state.measuring) return;
    const x = Math.round(state.mouse.x) + 0.5;
    const y = Math.round(state.mouse.y) + 0.5;
    if(x > chartW) return;


    ctx.save();
    ctx.strokeStyle = COLORS.crosshair;
    ctx.setLineDash([3,4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, volTop+volH);
    ctx.stroke();
    if(state.mouse.y <= mainH){
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(chartW, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);


    if(state.mouse.y <= mainH){
      const price = yToPrice(state.mouse.y, pExt);
      const label = fmtPrice(price);
      ctx.font = F_AXIS;
      const tw = ctx.measureText(label).width;
      const chipW = Math.max(AXIS_W, tw+16);
      ctx.fillStyle = COLORS.chipBg;
      ctx.strokeStyle = COLORS.chipBorder;
      ctx.lineWidth = 1;
      roundRect(ctx, chartW+2, y-9, chipW-2, 18, 4);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = COLORS.chipText;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, chartW+10, y+0.5);
    }
    const idx = clampIndex(xToIndex(state.mouse.x));
    const c = state.candles[idx];
    if(c){
      /* Точка-маркер на пересечении крестика с ценой закрытия наведённого бара */
      const dotY = Math.round(priceToY(c.c, pExt));
      if(state.mouse.y <= mainH && dotY >= 0 && dotY <= mainH){
        const dotX = Math.round(indexToX(idx));
        ctx.fillStyle = c.c >= c.o ? COLORS.up : COLORS.down;
        ctx.beginPath();
        ctx.arc(dotX+0.5, dotY+0.5, 3, 0, Math.PI*2);
        ctx.fill();
        ctx.strokeStyle = COLORS.crosshairDot;
        ctx.lineWidth = 1;
        ctx.stroke();
      }


      const label = fmtTimeAxis(c.t, state.interval);
      ctx.font = F_AXIS;
      const tw = ctx.measureText(label).width;
      const chipX = Math.min(Math.max(0,x-tw/2-8), chartW-tw-16);
      ctx.fillStyle = COLORS.chipBg;
      ctx.strokeStyle = COLORS.chipBorder;
      ctx.lineWidth = 1;
      roundRect(ctx, chipX, cssH-TIME_AXIS_H+2, tw+16, TIME_AXIS_H-6, 4);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = COLORS.chipText;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, Math.min(Math.max(tw/2+8,x), chartW-tw/2-8), cssH-TIME_AXIS_H/2-1);
    }
    ctx.restore();
  }


  function clampIndex(i){
    return Math.max(0, Math.min(state.candles.length-1, i));
  }


  function drawMeasurement(ext, chartW, mainH){
    state.measurements.forEach(m => {
      drawSingleMeasurement(m.start, m.end, ext, chartW, mainH);
    });


    if (state.pendingMeasurement) {
      const start = state.pendingMeasurement.start;
      const sx = Math.round(indexToX(start.index)) + 0.5;
      const sy = Math.round(priceToY(start.price, ext)) + 0.5;


      ctx.save();
      ctx.fillStyle = '#5A87FF';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(sx, sy, 4, 0, Math.PI*2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();


      if (state.mouse.inChart && state.mouse.x != null && state.mouse.x <= chartW) {
        const mx = Math.round(state.mouse.x) + 0.5;
        const my = Math.round(state.mouse.y) + 0.5;
        const endIdx = clampIndex(xToIndex(state.mouse.x));
        const endPrice = yToPrice(Math.max(0, Math.min(state.mouse.y, mainH)), ext);
        const ex = Math.round(indexToX(endIdx)) + 0.5;
        const ey = Math.round(priceToY(endPrice, ext)) + 0.5;


        ctx.save();
        ctx.strokeStyle = 'rgba(90,135,255,0.8)';
        ctx.setLineDash([4,4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
    }
  }


  function drawSingleMeasurement(start, end, ext, chartW, mainH){
    const sIdx = clampIndex(start.index), eIdx = clampIndex(end.index);
    const sPrice = start.price, ePrice = end.price;
    const sx = Math.round(indexToX(sIdx)) + 0.5;
    const ex = Math.round(indexToX(eIdx)) + 0.5;
    const sy = Math.round(priceToY(sPrice, ext)) + 0.5;
    const ey = Math.round(priceToY(ePrice, ext)) + 0.5;
    const up = ePrice >= sPrice;
    const color = up ? COLORS.up : COLORS.down;
    const softColor = up ? COLORS.upSoft : COLORS.downSoft;


    ctx.save();
    ctx.fillStyle = softColor;
    ctx.fillRect(Math.min(sx,ex), Math.min(sy,ey), Math.abs(ex-sx), Math.abs(ey-sy));
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.7;
    ctx.strokeRect(Math.min(sx,ex)+0.5, Math.min(sy,ey)+0.5, Math.abs(ex-sx), Math.abs(ey-sy));
    ctx.globalAlpha = 1;


    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.setLineDash([2,3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, sy);
    ctx.lineTo(chartW, sy);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, ey);
    ctx.lineTo(chartW, ey);
    ctx.stroke();
    ctx.setLineDash([]);


    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.moveTo(ex, Math.min(sy,ey));
    ctx.lineTo(ex, Math.max(sy,ey));
    ctx.stroke();


    drawAxisChip(sy, fmtPrice(sPrice), '#20242c', '#c7cad2', chartW);
    drawAxisChip(ey, fmtPrice(ePrice), color, '#08090b', chartW);


    const pct = ((ePrice - sPrice)/sPrice) * 100;
    const diff = ePrice - sPrice;
    const bars = Math.abs(eIdx - sIdx);
    const lines = [ (up?'+':'') + pct.toFixed(2)+'%', (up?'+':'')+fmtPrice(diff), bars + ' баров' ];
    ctx.font = F_STAT_TITLE;
    const w1 = ctx.measureText(lines[0]).width;
    ctx.font = F_STAT;
    const w2 = Math.max(ctx.measureText(lines[1]).width, ctx.measureText(lines[2]).width);
    const boxW = Math.max(w1,w2) + 24;
    const boxH = 58;
    let bx = ex + 12;
    let by = ey - boxH/2;
    if(bx + boxW > chartW) bx = ex - boxW - 12;
    by = Math.max(4, Math.min(mainH-boxH-4, by));


    ctx.fillStyle = 'rgba(12,14,17,0.92)';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    roundRect(ctx, bx, by, boxW, boxH, 8);
    ctx.fill(); ctx.stroke();


    ctx.textAlign = 'left';
    ctx.fillStyle = color;
    ctx.font = F_STAT_TITLE;
    ctx.textBaseline = 'top';
    ctx.fillText(lines[0], bx+12, by+8);
    ctx.fillStyle = '#9ba1ad';
    ctx.font = F_STAT;
    ctx.fillText(lines[1], bx+12, by+28);
    ctx.fillText(lines[2], bx+12, by+42);


    ctx.restore();
  }


  function drawAxisChip(y, text, bg, fg, chartW){
    ctx.save();
    ctx.font = F_AXIS_SEMI;
    const tw = ctx.measureText(text).width;
    const w = Math.max(AXIS_W, tw+16);
    ctx.fillStyle = bg;
    roundRect(ctx, chartW+2, y-9, w-2, 18, 4);
    ctx.fill();
    ctx.fillStyle = fg;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, chartW+10, y+0.5);
    ctx.restore();
  }


  function roundRect(ctx,x,y,w,h,r){
    ctx.beginPath();
    ctx.moveTo(x+r,y);
    ctx.arcTo(x+w,y,x+w,y+h,r);
    ctx.arcTo(x+w,y+h,x,y+h,r);
    ctx.arcTo(x,y+h,x,y,r);
    ctx.arcTo(x,y,x+w,y,r);
    ctx.closePath();
  }


  function updateOhlcStrip(ext){
    const idx = (state.hoverIndex != null) ? state.hoverIndex : state.candles.length-1;
    const c = state.candles[idx];
    if(!c) return;
    const up = c.c >= c.o;
    ohlcO.textContent = fmtPrice(c.o);
    ohlcH.textContent = fmtPrice(c.h);
    ohlcL.textContent = fmtPrice(c.l);
    ohlcC.textContent = fmtPrice(c.c);
    ohlcC.className = up ? 'up' : 'down';
    ohlcV.textContent = fmtVol(c.v);
  }


  canvas.addEventListener('mousemove', (e)=>{
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    state.mouse.x = x; state.mouse.y = y; state.mouse.inChart = true;
    const {chartW, mainH} = layout();


    if(x > chartW) canvas.style.cursor = 'ns-resize';
    else canvas.style.cursor = 'crosshair';


    if(state.axisDragging){
      const dy = y - state.axisDragStartY;
      const base = state.axisDragBaseRange;
      const mid = (base.min+base.max)/2;
      const scale = clampScale(Math.exp(dy*0.006));
      const half = (base.max-base.min)/2*scale;
      state.manualPriceRange = {min: mid-half, max: mid+half};
    } else if(state.dragging){
      const dx = x - state.dragStartX;
      const dy = y - state.dragStartY;
      if(Math.abs(dx) > 2 || Math.abs(dy) > 2) state.didDrag = true;
      const newOffset = state.dragStartOffset + Math.round(dx / state.candleWidth);
      state.offset = clampOffset(newOffset);


      if(state.dragStartPriceRange){
        const base = state.dragStartPriceRange;
        const usable = mainH - PAD_TOP - PAD_BOTTOM;
        const pricePerPixel = (base.max - base.min) / usable;
        const deltaP = dy * pricePerPixel;
        state.manualPriceRange = {min: base.min + deltaP, max: base.max + deltaP};
      }
    } else {
      state.hoverIndex = clampIndex(xToIndex(Math.min(x,chartW)));
    }
    draw();
  });


  canvas.addEventListener('mouseleave', ()=>{
    state.mouse.inChart = false;
    state.hoverIndex = null;
    if(state.dragging) endDrag();
    if(state.axisDragging) state.axisDragging = false;
    draw();
  });


  canvas.addEventListener('mousedown', (e)=>{
    if(e.button === 2) {
      handleRightClick(e);
      return;
    }
    if(e.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const {chartW, mainH} = layout();


    if(x > chartW){
      const base = priceExtent();
      if(!state.manualPriceRange) state.manualPriceRange = {min: base.min, max: base.max};
      state.axisDragging = true;
      state.axisDragStartY = y;
      state.axisDragBaseRange = {min: state.manualPriceRange.min, max: state.manualPriceRange.max};
      return;
    }


    if(state.measureToolActive){
      if(!state.pendingMeasurement){
        const ext = priceExtent();
        const idx = clampIndex(xToIndex(x));
        const price = yToPrice(Math.max(0, Math.min(y, mainH)), ext);
        state.pendingMeasurement = { start: {index: idx, price: price} };
        draw();
      } else {
        const ext = priceExtent();
        const idx = clampIndex(xToIndex(x));
        const price = yToPrice(Math.max(0, Math.min(y, mainH)), ext);
        const newMeasurement = {
          start: state.pendingMeasurement.start,
          end: {index: idx, price: price}
        };
        state.measurements.push(newMeasurement);
        state.pendingMeasurement = null;
        state.measureToolActive = false;
        draw();
      }
      return;
    }


    state.dragging = true;
    state.didDrag = false;
    state.dragStartX = x;
    state.dragStartY = y;
    state.dragStartOffset = state.offset;
    state.dragStartPriceRange = state.manualPriceRange ? {min: state.manualPriceRange.min, max: state.manualPriceRange.max} : null;
  });


  canvas.addEventListener('contextmenu', (e) => e.preventDefault());


  function handleRightClick(e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const {chartW, mainH} = layout();
    if (x > chartW) return;
    const ext = priceExtent();


    let foundIndex = -1;
    state.measurements.forEach((m, idx) => {
      const sIdx = clampIndex(m.start.index);
      const eIdx = clampIndex(m.end.index);
      const sPrice = m.start.price;
      const ePrice = m.end.price;
      const sx = indexToX(sIdx);
      const ex = indexToX(eIdx);
      const sy = priceToY(sPrice, ext);
      const ey = priceToY(ePrice, ext);
      const minX = Math.min(sx, ex) - 4;
      const maxX = Math.max(sx, ex) + 4;
      const minY = Math.min(sy, ey) - 4;
      const maxY = Math.max(sy, ey) + 4;
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
        foundIndex = idx;
      }
    });


    if (foundIndex !== -1) {
      state.measurements.splice(foundIndex, 1);
      draw();
    }
  }


  canvas.addEventListener('dblclick', (e)=>{
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const {chartW} = layout();
    if(x > chartW){
      state.manualPriceRange = autoPriceExtent();
      draw();
    }
  });


  window.addEventListener('mouseup', ()=>{
    if(state.dragging) endDrag();
    if(state.axisDragging) state.axisDragging = false;
  });


  function endDrag(){
    state.dragging = false;
    if(!state.didDrag){
      state.measurement = null;
      draw();
    }
  }


  window.addEventListener('keydown', (e)=>{
    if(e.key === 'Escape'){
      state.measurements = [];
      state.pendingMeasurement = null;
      state.measureToolActive = false;
      draw();
    }
    if(e.key === 'Shift' && !state.shiftDown){
      state.shiftDown = true;
      state.measureToolActive = true;
      state.pendingMeasurement = null;
      draw();
    }
  });
  window.addEventListener('keyup', (e)=>{
    if(e.key === 'Shift'){
      state.shiftDown = false;
    }
  });
  window.addEventListener('blur', ()=>{
    state.shiftDown = false;
  });


  canvas.addEventListener('wheel', (e)=>{
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const {chartW} = layout();


    if(Math.abs(e.deltaX) > Math.abs(e.deltaY)){
      const deltaCandles = e.deltaX / state.candleWidth;
      state.offset = clampOffset(state.offset + deltaCandles);
      draw();
      return;
    }


    const idxAtCursor = clampIndex(xToIndex(x));
    const factor = e.deltaY > 0 ? 0.88 : 1.14;
    const newSlot = Math.max(0.5, Math.min(80, state.candleWidth*factor));
    state.candleWidth = newSlot;


    const targetRightIdx = idxAtCursor + Math.round((chartW - x)/newSlot);
    state.offset = clampOffset(state.candles.length - 1 - targetRightIdx);


    draw();
  }, {passive:false});


  function clampOffset(o){
    const n = state.candles.length;
    if(n===0) return 0;
    const maxFuture = maxFutureCandles();
    return Math.max(-maxFuture, Math.min(n-1, Math.round(o)));
  }


  /* === ИЗМЕНЕНО: безопасная обработка ответа === */
  async function fetchKlines(symbol, interval, limit, endTime) {
    let url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    if (endTime) url += `&endTime=${endTime}`;

    const res = await fetch(url);
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 200); } catch (_) {}
      const err = new Error('klines http ' + res.status + (detail ? ': ' + detail : ''));
      err.status = res.status;
      throw err;
    }

    const raw = await res.json();
    if (!Array.isArray(raw)) {
      const err = new Error('klines: unexpected response (not an array)');
      err.status = res.status;
      throw err;
    }

    return raw.map(k => ({
      t: k[0], o: parseFloat(k[1]), h: parseFloat(k[2]), l: parseFloat(k[3]),
      c: parseFloat(k[4]), v: parseFloat(k[5])
    }));
  }

  async function fetch24hr(symbol) {
    const url = `https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${symbol}`;
    const res = await fetch(url);
    if (!res.ok) {
      const err = new Error('24hr http ' + res.status);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    if (!data || typeof data !== 'object') {
      const err = new Error('24hr: unexpected response');
      err.status = res.status;
      throw err;
    }
    return data;
  }
  /* ============================================ */


  function connectWs(symbol, interval, token){
    const s = symbol.toLowerCase();
    const streams = [`${s}@kline_${interval}`, `${s}@aggTrade`, `${s}@ticker`].join('/');
    const url = `wss://fstream.binance.com/market/stream?streams=${streams}`;
    const ws = new WebSocket(url);
    state.ws = ws;


    ws.onopen = ()=>{ if(token===state.wsToken) connDot.classList.add('live'); };
    ws.onclose = ()=>{
      connDot.classList.remove('live');
      if(token === state.wsToken){
        setTimeout(()=>{ if(token===state.wsToken) connectWs(symbol, interval, token); }, 1500);
      }
    };
    ws.onerror = ()=>{ try{ws.close();}catch(_){} };
    ws.onmessage = (ev)=>{
      if(token !== state.wsToken) return;
      let msg;
      try{ msg = JSON.parse(ev.data); } catch(_){ return; }
      const streamName = msg.stream || '';
      const data = msg.data || msg;
      if(streamName.endsWith('@kline_'+interval) && data.k){
        handleKline(data.k);
      } else if(streamName.endsWith('@aggTrade') && data.p){
        state.lastTradePrice = parseFloat(data.p);
        updateHeaderPrice();
        draw();
      } else if(streamName.endsWith('@ticker')){
        state.ticker24h = data;
        updateHeaderPrice();
      }
    };
  }


  function handleKline(k){
    const t = k.t;
    const bar = {t, o:parseFloat(k.o), h:parseFloat(k.h), l:parseFloat(k.l), c:parseFloat(k.c), v:parseFloat(k.v)};
    const arr = state.candles;
    const last = arr[arr.length-1];
    if(last && last.t === t){
      arr[arr.length-1] = bar;
    } else if(!last || t > last.t){
      arr.push(bar);
      if (state.offset > 0) {
        state.offset += 1;
      } else if (state.offset < 0) {
        state.offset -= 1;
      }
    }
    state.lastTradePrice = bar.c;
    updateHeaderPrice();
    draw();
  }


  function updateHeaderPrice(){
    const last = state.candles[state.candles.length-1];
    const price = state.lastTradePrice != null ? state.lastTradePrice : (last?last.c:null);
    lastPriceEl.textContent = price!=null ? fmtPrice(price) : '—';
    let pct = null;
    if(state.ticker24h && state.ticker24h.P != null){
      pct = parseFloat(state.ticker24h.P);
    }
    if(pct != null){
      pctChangeEl.textContent = fmtPct(pct);
      pctChangeEl.className = 'pct ' + (pct>=0?'up':'down');
    } else {
      pctChangeEl.textContent = '—';
      pctChangeEl.className = 'pct';
    }
  }


  async function loadSymbolInterval(symbol, interval){
    state.wsToken++;
    const myToken = state.wsToken;
    if(state.ws){ try{ state.ws.onclose=null; state.ws.close(); }catch(_){} }
    connDot.classList.remove('live');


    loadingOverlay.classList.remove('hidden');
    state.symbol = symbol; state.interval = interval;
    state.candles = [];
    state.offset = 0;
    state.manualPriceRange = null;
    state.measurements = [];
    state.pendingMeasurement = null;
    state.measureToolActive = false;
    state.lastTradePrice = null;
    symbolInput.value = symbol;
    lastPriceEl.textContent = '—';
    pctChangeEl.textContent = '—'; pctChangeEl.className = 'pct';


    try{
      const [klines, ticker] = await Promise.all([
        fetchKlines(symbol, interval, state.limit),
        fetch24hr(symbol).catch(()=>null)
      ]);
      if(myToken !== state.wsToken) return;
      state.candles = klines;
      state.ticker24h = ticker;
      updateHeaderPrice();
      state.manualPriceRange = autoPriceExtent();
      draw();
      connectWs(symbol, interval, myToken);
    } catch(err){
      console.error(err);
    } finally {
      if(myToken === state.wsToken) loadingOverlay.classList.add('hidden');
    }
  }


  document.getElementById('intervalRow').addEventListener('click', (e)=>{
    const btn = e.target.closest('.ivl');
    if(!btn) return;
    document.querySelectorAll('.ivl').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    loadSymbolInterval(state.symbol, btn.dataset.ivl);
  });


  symbolInput.addEventListener('keydown', (e)=>{
    if(e.key === 'Enter'){
      const sym = symbolInput.value.trim().toUpperCase();
      if(sym.length >= 5){
        loadSymbolInterval(sym, state.interval);
        if(window.onChartSymbolChanged) window.onChartSymbolChanged(sym);
      }
    }
  });


  fitCanvas();
  loadSymbolInterval(state.symbol, state.interval);


  async function loadMoreHistory() {
    if (state.historyLoading || state.candles.length === 0) return;
    state.historyLoading = true;
    const earliestTime = state.candles[0].t;
    const symbol = state.symbol;
    const interval = state.interval;
    const limit = Math.min(state.limit, 1000);
    try {
      const olderCandles = await fetchKlines(symbol, interval, limit, earliestTime - 1);
      if (olderCandles.length > 0 && olderCandles[olderCandles.length-1].t < earliestTime) {
        state.candles = olderCandles.concat(state.candles);
        draw();
      }
    } catch (err) {
      console.error('Ошибка подгрузки истории:', err);
    } finally {
      state.historyLoading = false;
    }
  }


  /* Публичный API для внешнего управления графиком (используется скринером справа) */
  window.ChartAPI = {
    load: function(symbol, interval){
      loadSymbolInterval(symbol, interval || state.interval);
    },
    currentSymbol: function(){ return state.symbol; },
    currentInterval: function(){ return state.interval; }
  };


})();