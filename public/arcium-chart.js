/*! Arcium chart · MIT License · (c) 2026 Arcium
   A canvas chart with no dependencies and no data provider: the options scanner's chart, grown into
   one chart for every Arcium dashboard. You hand it the numbers; it draws them.

     const chart = ArciumChart.create(element, { height: 420 });
     chart.setData({
       mode: 'candles',                     // 'candles' (first series OHLC), 'line', 'compare' (rebased %), 'ratio' (A / B)
       series: [{ id: 'SPY', name: 'SPY', color: '#0D9FD8', data: [{ t: 1704067200000, o, h, l, c, v }, ...] },
                { id: 'XLK', data: [{ t, c }, ...] }],          // a line series needs only t and c (or v)
       volume: true,                        // candles mode: volume under the price
       lines: [{ y: 480, color: '#e11d48', label: 'Target', dash: [6, 4] }],   // fit: false = don't stretch the scale for it
       bands: { color: '#64748b', data: [{ t, m, u, l }] },     // average with upper/lower band
       format: v => v.toFixed(2),           // price-axis numbers (compare mode shows %)
       timeFormat: t => 'Step ' + t,        // optional: label times yourself (axis and legend), e.g. step numbers
       // a series with area: true is shaded under its line
       rate: 'D',                           // optional: the interval of the bars handed in (else measured)
     });
     chart.destroy();

   Controls (optional): ArciumChart.create(element, { controls: { interval: 'D', range: '1Y', onInterval } })
   adds a strip above the chart: Interval (1m … M) and Show (1D … All, or the last 50 … 1000 points
   when times are steps). Without onInterval the chart groups its own bars into a coarser interval;
   with it, choosing an interval calls onInterval(key) and you hand back bars at that rate (setData
   with rate: key). Zooming clears the Show choice; the strip counts the bars in view.

   Drag to pan, wheel or pinch to zoom, double-click to reset. The legend follows the crosshair.
   Colours come from CSS variables on the element when present (--ac-bg, --ac-text, --ac-muted,
   --ac-grid, --ac-up, --ac-down), else light/dark defaults from prefers-color-scheme. */
(function (root) {
  'use strict';
  var PALETTE = ['#0D9FD8', '#f59e0b', '#10b981', '#a855f7', '#ef4444', '#64748b', '#ec4899', '#14b8a6', '#eab308', '#6366f1'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var AXIS_W = 64, BOTTOM_H = 22, VOL_H = 56, GAP = 6, TOP = 26;

  function theme(el) {
    var cs = getComputedStyle(el), dark = root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)').matches;
    function v(name, light, darkv) { var x = cs.getPropertyValue(name).trim(); return x || (dark ? darkv : light); }
    return {
      bg: v('--ac-bg', '#ffffff', '#0f1216'), text: v('--ac-text', '#15181d', '#e8eaee'),
      muted: v('--ac-muted', '#6b7280', '#8b95a5'), grid: v('--ac-grid', '#eef0f3', '#1c2128'),
      up: v('--ac-up', '#16a34a', '#22c55e'), down: v('--ac-down', '#dc2626', '#ef4444'),
    };
  }

  function niceStep(span, n) {
    var raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    return [1, 2, 2.5, 5, 10].map(function (m) { return m * mag; }).find(function (s) { return s >= raw; }) || raw;
  }

  function closeOf(p) { return p.c != null ? p.c : p.v; }

  /** Align every series on the union of timestamps; a missing value carries the last one forward
   *  (so compare/ratio lines don't break on a holiday in one market). */
  function align(series) {
    var ts = {};
    series.forEach(function (s) { s.data.forEach(function (p) { ts[p.t] = 1; }); });
    var times = Object.keys(ts).map(Number).sort(function (a, b) { return a - b; });
    var cols = series.map(function (s) {
      var m = {}; s.data.forEach(function (p) { m[p.t] = p; });
      var last = null;
      return times.map(function (t) { if (m[t]) last = m[t]; return m[t] || (last ? { t: t, c: closeOf(last), carried: true } : null); });
    });
    return { times: times, cols: cols };
  }

  // ── intervals and the visible sample (the controls strip) ──
  var DAY = 86400000;
  var INTERVALS = [['M1', '1m', 6e4], ['M5', '5m', 3e5], ['M15', '15m', 9e5], ['M30', '30m', 18e5], ['H1', '1h', 36e5],
                   ['H4', '4h', 144e5], ['D', 'D', DAY], ['W', 'W', 7 * DAY], ['M', 'M', 30 * DAY]];
  var RANGES = [['1D', DAY], ['5D', 5 * DAY], ['1M', 30 * DAY], ['3M', 91 * DAY], ['6M', 182 * DAY], ['YTD', 0],
                ['1Y', 365 * DAY], ['2Y', 730 * DAY], ['5Y', 1826 * DAY], ['All', Infinity]];
  var COUNTS = [50, 100, 250, 500, 1000];
  function ivMs(k) { for (var i = 0; i < INTERVALS.length; i++) if (INTERVALS[i][0] === k) return INTERVALS[i][2]; return null; }

  /** The bar interval of a series, from its typical spacing. */
  function stepOf(data) {
    var d = [];
    for (var i = 1; i < data.length && d.length < 400; i++) d.push(data[i].t - data[i - 1].t);
    d.sort(function (a, b) { return a - b; });
    return d.length ? d[Math.floor(d.length / 2)] : DAY;
  }

  function bucketOf(t, k, ms) {
    var d = new Date(t);
    if (k === 'W') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (d.getUTCDay() + 6) % 7);   // Monday
    if (k === 'M') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    return Math.floor(t / ms) * ms;
  }

  /** Groups bars (or single values) into a coarser interval: open of the first, high/low over all,
   *  close of the last, volume summed. */
  function resample(data, k) {
    var ms = ivMs(k), out = [], cur = null;
    data.forEach(function (p) {
      var b = bucketOf(p.t, k, ms), c = closeOf(p), bar = p.c != null;
      if (c == null) return;
      if (!cur || cur.t !== b) {
        cur = { t: b, o: p.o != null ? p.o : c, h: p.h != null ? p.h : c, l: p.l != null ? p.l : c, c: c };
        if (bar) cur.v = p.v || 0;
        out.push(cur);
        return;
      }
      cur.h = Math.max(cur.h, p.h != null ? p.h : c); cur.l = Math.min(cur.l, p.l != null ? p.l : c); cur.c = c;
      if (bar) cur.v = (cur.v || 0) + (p.v || 0);
    });
    return out;
  }

  var STYLE = '.ac-bar{display:flex;flex-wrap:wrap;align-items:center;gap:4px 14px;padding:2px 0 6px;font:12px ui-sans-serif,system-ui,sans-serif}' +
    '.ac-grp{display:inline-flex;flex-wrap:wrap;align-items:center;gap:2px}' +
    '.ac-grp>span,.ac-n{color:var(--ac-muted,#6b7280);margin-right:4px}.ac-n{margin:0 0 0 auto}' +
    '.ac-bar button{border:1px solid transparent;background:none;color:inherit;font:inherit;padding:2px 7px;border-radius:5px;cursor:pointer}' +
    '.ac-bar button:hover:not(:disabled){border-color:currentColor}' +
    '.ac-bar button.on{background:var(--ac-accent,#0D9FD8);color:#fff}' +
    '.ac-bar button:disabled{opacity:.35;cursor:default}';
  var styled = false;

  function create(el, opts) {
    opts = opts || {};
    var ctl = opts.controls ? (opts.controls === true ? {} : opts.controls) : null;
    var cv = document.createElement('canvas');
    var h = opts.height || 420;   // a number of pixels, or any CSS height such as '100%'
    cv.style.cssText = 'display:block;width:100%;height:' + (typeof h === 'number' ? h + 'px' : h) + ';touch-action:none;cursor:crosshair';
    cv.setAttribute('role', 'img');
    var bar = null, countEl = null;
    if (ctl) {
      if (!styled && document.head) { var st = document.createElement('style'); st.textContent = STYLE; document.head.appendChild(st); styled = true; }
      bar = document.createElement('div');
      bar.className = 'ac-bar';
      el.appendChild(bar);
      if (typeof h !== 'number') {   // the strip and the chart share the element's height
        el.style.display = 'flex'; el.style.flexDirection = 'column';
        cv.style.height = 'auto'; cv.style.flex = '1 1 auto'; cv.style.minHeight = '0';
      }
    }
    el.appendChild(cv);
    var ctx = cv.getContext('2d');
    var state = { mode: 'line', series: [], lines: [], bands: null, volume: false, format: null, timeFormat: null };
    var view = null, hover = null, aligned = null, drag = null, pinch = null;
    var raw = [], rawStep = DAY, interval = ctl && ctl.interval || null, range = ctl && ctl.range || null, waiting = false;

    function data() { return aligned; }

    function rows() {   // [{t, vals:[number|null per series], ohlc}] in drawing units
      var a = data(); if (!a) return [];
      var mode = state.mode, n = a.times.length, out = new Array(n);
      var base = a.cols.map(function () { return null; });
      if (mode === 'compare' && view) {   // rebase to the first visible bar
        var from = Math.max(0, Math.floor(view.end - plotW() / view.cw));
        a.cols.forEach(function (col, k) {
          for (var i = from; i < n; i++) if (col[i]) { base[k] = closeOf(col[i]); break; }
        });
      }
      for (var i = 0; i < n; i++) {
        var vals = a.cols.map(function (col, k) {
          var p = col[i]; if (!p) return null;
          var c = closeOf(p);
          if (mode === 'compare') return base[k] ? (c / base[k] - 1) * 100 : null;
          return c;
        });
        if (mode === 'ratio') {
          var A = a.cols[0][i], B = a.cols[1] && a.cols[1][i];
          vals = [A && B && closeOf(B) ? closeOf(A) / closeOf(B) : null];
        }
        out[i] = { t: a.times[i], vals: vals, ohlc: mode === 'candles' ? a.cols[0][i] : null };
      }
      return out;
    }

    function plotW() { return cv.clientWidth - AXIS_W; }

    function resetView() {
      var n = aligned ? aligned.times.length : 0, pw = plotW();
      view = { cw: Math.max(2, Math.min(18, pw / Math.min(n || 1, 160))), end: n - 1 };
    }

    /** A time range the data can't show: shorter than two bars, or longer than the history (that's All). */
    function rangeOff(r) {
      var T = aligned ? aligned.times : [], n = T.length, span = n > 1 ? T[n - 1] - T[0] : 0;
      var step = state.series[0] ? stepOf(state.series[0].data) : rawStep;
      return n < 2 || (r[0] !== 'All' && r[0] !== 'YTD' && (r[1] < step * 2 || r[1] > span * 1.05));
    }

    /** The view for the Show choice: the bars since the range's start (or the last N), ending at the latest. */
    function applyRange() {
      if (!range || !aligned || plotW() <= 0) return;
      if (!state.timeFormat && RANGES.some(function (x) { return x[0] === range && rangeOff(x); })) return;   // the default view
      var T = aligned.times, n = T.length, count = 0;
      if (state.timeFormat) count = range === 'All' ? n : Number(range);
      else {
        var r = RANGES.filter(function (x) { return x[0] === range; })[0];
        if (!r) return;
        var last = T[n - 1], from = range === 'YTD' ? Date.UTC(new Date(last).getUTCFullYear(), 0, 1) : last - r[1];
        for (var i = n - 1; i >= 0 && T[i] >= from; i--) count++;
      }
      count = Math.max(1, Math.min(n, count));
      view = { cw: plotW() / count, end: n - 1 };
    }

    /** The series as drawn: grouped into the chosen interval when it is coarser than the bars handed in. */
    function rebuild() {
      var k = interval && ivMs(interval) > rawStep * 1.5 ? interval : null;
      state.series = raw.map(function (s) { return k ? Object.assign({}, s, { data: resample(s.data, k) }) : s; });
      aligned = state.series.length ? align(state.series) : null;
    }

    function nearestInterval(ms) {
      var best = INTERVALS[0][0], d = Infinity;
      INTERVALS.forEach(function (iv) { var x = Math.abs(Math.log(iv[2] / ms)); if (x < d) { d = x; best = iv[0]; } });
      return best;
    }

    function chooseInterval(k) {
      interval = k;
      if (ctl.onInterval) ctl.onInterval(k);   // the page hands back bars at that rate
      else { rebuild(); view = null; }
      paintBar(); draw();
    }
    function chooseRange(k) { range = k; view = null; paintBar(); draw(); }
    function dropRange() { if (range) { range = null; paintBar(); } }

    function paintBar() {
      if (!bar) return;
      bar.textContent = '';
      var n = aligned ? aligned.times.length : 0;
      function group(label, items) {
        var g = document.createElement('div');
        g.className = 'ac-grp'; g.setAttribute('role', 'group'); g.setAttribute('aria-label', label);
        var s = document.createElement('span'); s.textContent = label; g.appendChild(s);
        items.forEach(function (it) {
          var b = document.createElement('button');
          b.type = 'button'; b.textContent = it.label; b.setAttribute('data-key', it.key);
          if (it.on) b.className = 'on';
          b.setAttribute('aria-pressed', it.on ? 'true' : 'false');
          b.disabled = !!it.off;
          if (it.title) b.title = it.title;
          b.addEventListener('click', it.go);
          g.appendChild(b);
        });
        bar.appendChild(g);
      }
      if (!state.timeFormat) {
        var cur = interval || nearestInterval(rawStep);
        group('Interval', INTERVALS.map(function (iv) {
          var off = !ctl.onInterval && iv[2] < rawStep * 0.9;
          return { key: iv[0], label: iv[1], on: iv[0] === cur, off: off, title: off ? 'Finer than the data' : null,
                   go: function () { chooseInterval(iv[0]); } };
        }));
        group('Show', RANGES.map(function (r) {
          var off = rangeOff(r);
          return { key: r[0], label: r[0], on: range === r[0] && !off, off: off, go: function () { chooseRange(r[0]); } };
        }));
      } else {
        group('Show last', COUNTS.filter(function (c) { return c < n; }).map(function (c) {
          return { key: String(c), label: String(c), on: range === String(c), go: function () { chooseRange(String(c)); } };
        }).concat([{ key: 'All', label: 'All', on: range === 'All', go: function () { chooseRange('All'); } }]));
      }
      countEl = document.createElement('span'); countEl.className = 'ac-n'; bar.appendChild(countEl);
    }

    function clampView() {
      var n = aligned.times.length, pw = plotW();
      view.cw = Math.max(Math.max(0.6, pw / Math.max(n, 1) * 0.8), Math.min(40, view.cw));
      var minEnd = Math.min(n - 1, pw / view.cw - 1);
      view.end = Math.max(minEnd, Math.min(n - 1 + 8, view.end));
    }

    function draw() {
      var dpr = root.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight, th = theme(el);
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
      if (!aligned || !aligned.times.length) {
        ctx.fillStyle = th.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(opts.empty || 'No data', W / 2, H / 2);
        if (countEl) countEl.textContent = '';
        return;
      }
      if (!view) applyRange();
      if (!view) resetView();
      clampView();
      var pw = plotW(), showVol = state.mode === 'candles' && state.volume;
      var ph = H - BOTTOM_H - TOP - (showVol ? VOL_H + GAP : 0), n = aligned.times.length;
      var cw = view.cw, end = view.end;
      function x(i) { return pw - (end - i + 0.5) * cw; }
      var iFrom = Math.max(0, Math.floor(end - pw / cw)), iTo = Math.min(n - 1, Math.ceil(end));
      if (countEl) countEl.textContent = (iTo - iFrom + 1).toLocaleString() + ' bars in view';
      var R = rows(), nSeries = state.mode === 'ratio' ? 1 : state.series.length;

      // y range over what's visible
      var lo = Infinity, hi = -Infinity, vmax = 0, i, k, r;
      for (i = iFrom; i <= iTo; i++) {
        r = R[i];
        if (r.ohlc && !r.ohlc.carried) { lo = Math.min(lo, r.ohlc.l != null ? r.ohlc.l : closeOf(r.ohlc)); hi = Math.max(hi, r.ohlc.h != null ? r.ohlc.h : closeOf(r.ohlc)); vmax = Math.max(vmax, r.ohlc.v || 0); }
        for (k = 0; k < nSeries; k++) { var v = r.vals[k]; if (v != null && isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
      }
      if (state.bands) state.bands.data.forEach(function (b) { if (b.t >= aligned.times[iFrom] && b.t <= aligned.times[iTo]) { lo = Math.min(lo, b.l); hi = Math.max(hi, b.u); } });
      state.lines.forEach(function (l) { if (l.fit !== false) { lo = Math.min(lo, l.y); hi = Math.max(hi, l.y); } });
      if (!isFinite(lo)) { lo = 0; hi = 1; }
      var pad = (hi - lo) * 0.06 || Math.abs(hi) * 0.01 || 1; lo -= pad; hi += pad;
      function y(v) { return TOP + (hi - v) / (hi - lo) * ph; }
      var fmt = state.mode === 'compare' ? function (v) { return (v >= 0 ? '+' : '') + v.toFixed(Math.abs(hi - lo) < 4 ? 2 : 1) + '%'; }
        : state.format || function (v) { var a = Math.abs(v); return a >= 1000 ? v.toFixed(0) : a >= 10 ? v.toFixed(2) : v.toFixed(4); };

      // grid + axis
      var step = niceStep(hi - lo, 6);
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      for (var gv = Math.ceil(lo / step) * step; gv <= hi; gv += step) {
        if (Math.abs(gv) < step * 1e-9) gv = 0;   // no "-0.00" from floating-point steps
        var gy = Math.round(y(gv)) + 0.5;
        ctx.strokeStyle = th.grid; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(pw, gy); ctx.stroke();
        ctx.fillStyle = th.muted; ctx.fillText(fmt(gv), pw + 6, gy);
      }
      if (state.mode === 'compare') { ctx.strokeStyle = th.muted; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(0, y(0)); ctx.lineTo(pw, y(0)); ctx.stroke(); ctx.setLineDash([]); }

      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pw, H); ctx.clip();

      // dates along the bottom
      var span = aligned.times[iTo] - aligned.times[iFrom], intraday = span < 6 * 86400000 || (n > 1 && aligned.times[1] - aligned.times[0] < 86400000 && span < 40 * 86400000);
      var every = Math.max(1, Math.ceil(70 / cw));
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = th.muted;
      for (i = iFrom; i <= iTo; i++) {
        if (i % every || x(i) < 24 || x(i) > pw - 24) continue;
        var d = new Date(aligned.times[i]), lbl;
        if (intraday) lbl = (d.getHours() === 0 && d.getMinutes() === 0) ? MON[d.getMonth()] + ' ' + d.getDate() : ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
        else lbl = span > 400 * 86400000 ? MON[d.getMonth()] + ' ' + d.getFullYear() : MON[d.getMonth()] + ' ' + d.getDate();
        if (state.timeFormat) lbl = state.timeFormat(aligned.times[i]);
        ctx.fillText(lbl, x(i), H - 6);
      }

      // bands (average solid, upper/lower dashed)
      if (state.bands) {
        var bm = {}; state.bands.data.forEach(function (b) { bm[b.t] = b; });
        ['m', 'u', 'l'].forEach(function (key) {
          ctx.strokeStyle = state.bands.color || th.muted; ctx.lineWidth = key === 'm' ? 1.5 : 1.1; ctx.setLineDash(key === 'm' ? [] : [5, 3]);
          ctx.beginPath(); var started = false;
          for (var j = iFrom; j <= iTo; j++) { var b = bm[aligned.times[j]]; if (!b) { started = false; continue; } var py = y(b[key]); if (!started) { ctx.moveTo(x(j), py); started = true; } else ctx.lineTo(x(j), py); }
          ctx.stroke();
        });
        ctx.setLineDash([]);
      }

      // candles + volume
      if (state.mode === 'candles') {
        var bw = Math.max(1, Math.min(14, cw * 0.7)), vy0 = TOP + ph + GAP + VOL_H;
        for (i = iFrom; i <= iTo; i++) {
          var c = R[i].ohlc; if (!c || c.carried || c.o == null) continue;
          var col = c.c >= c.o ? th.up : th.down, cx = Math.round(x(i)) + 0.5;
          if (showVol && vmax) { var vh = (c.v || 0) / vmax * VOL_H; ctx.globalAlpha = 0.35; ctx.fillStyle = col; ctx.fillRect(cx - bw / 2, vy0 - vh, bw, vh); ctx.globalAlpha = 1; }
          ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(cx, y(c.h)); ctx.lineTo(cx, y(c.l)); ctx.stroke();
          var top = y(Math.max(c.o, c.c)), bh = Math.max(1, Math.abs(y(c.o) - y(c.c)));
          ctx.fillRect(cx - bw / 2, top, bw, bh);
        }
      }

      // lines (every series in line/compare/ratio; series 2+ in candles mode as overlays)
      for (k = state.mode === 'candles' ? 1 : 0; k < nSeries; k++) {
        if (state.mode !== 'ratio' && state.series[k].area) {   // shaded area under the line
          var f0 = null, f1 = null;
          ctx.beginPath();
          for (i = iFrom; i <= iTo; i++) { var av = R[i].vals[k]; if (av == null || !isFinite(av)) continue; if (f0 == null) { ctx.moveTo(x(i), y(av)); f0 = i; } else ctx.lineTo(x(i), y(av)); f1 = i; }
          if (f0 != null) { ctx.lineTo(x(f1), TOP + ph); ctx.lineTo(x(f0), TOP + ph); ctx.closePath(); ctx.globalAlpha = 0.14; ctx.fillStyle = seriesColor(k); ctx.fill(); ctx.globalAlpha = 1; }
        }
        ctx.strokeStyle = seriesColor(k); ctx.lineWidth = k === 0 ? 1.8 : 1.5;
        ctx.beginPath(); var on = false;
        for (i = iFrom; i <= iTo; i++) { var val = R[i].vals[k]; if (val == null || !isFinite(val)) { on = false; continue; } if (!on) { ctx.moveTo(x(i), y(val)); on = true; } else ctx.lineTo(x(i), y(val)); }
        ctx.stroke();
      }

      // horizontal marker lines, labelled; one outside the scale shows as an arrow at the edge
      ctx.textBaseline = 'bottom';
      var edge = { up: 0, down: 0 };   // stacked arrows, right-aligned, clear of the in-range labels
      state.lines.forEach(function (l) {
        var ly = y(l.y), col = l.color || th.text, txt = (l.label ? l.label + ' ' : '') + fmt(l.y);
        if (ly < TOP || ly > TOP + ph) {
          var top = ly < TOP, ey = top ? TOP + 12 + 14 * edge.up++ : TOP + ph - 2 - 14 * edge.down++;
          ctx.textAlign = 'right'; ctx.fillStyle = col; ctx.fillText((top ? '↑ ' : '↓ ') + txt, pw - 8, ey); return;
        }
        ctx.textAlign = 'left';
        ctx.strokeStyle = col; ctx.lineWidth = 1.25; ctx.setLineDash(l.dash || [6, 4]);
        ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(pw, ly); ctx.stroke(); ctx.setLineDash([]);
        if (l.label) { ctx.fillStyle = col; ctx.fillText(txt, 8, ly - 2); }
      });

      // crosshair
      var hi2 = hover != null ? Math.max(iFrom, Math.min(iTo, hover)) : null;
      if (hi2 != null) {
        var hx = Math.round(x(hi2)) + 0.5;
        ctx.strokeStyle = th.muted; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(hx, TOP); ctx.lineTo(hx, H - BOTTOM_H); ctx.stroke(); ctx.setLineDash([]);
      }
      ctx.restore();

      // last-value tags on the axis, one per series
      var lastRow = R[Math.min(iTo, n - 1)], tags = [];
      for (k = 0; k < nSeries; k++) {
        var lv = state.mode === 'candles' && k === 0 ? (lastRow.ohlc ? closeOf(lastRow.ohlc) : null) : lastRow.vals[k];
        if (lv != null && isFinite(lv)) tags.push({ y: Math.max(TOP + 8, Math.min(TOP + ph - 8, y(lv))), v: lv, col: state.mode === 'candles' && k === 0 ? th.text : seriesColor(k) });
      }
      tags.sort(function (a, b) { return a.y - b.y; });
      for (k = 1; k < tags.length; k++) if (tags[k].y - tags[k - 1].y < 16) tags[k].y = tags[k - 1].y + 16;   // no overlaps
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      tags.forEach(function (tg) { ctx.fillStyle = tg.col; ctx.fillRect(pw + 1, tg.y - 8, AXIS_W - 1, 16); ctx.fillStyle = th.bg; ctx.fillText(fmt(tg.v), pw + 5, tg.y); });

      // legend: values under the crosshair (or the last bar)
      var li = hi2 != null ? hi2 : Math.min(iTo, n - 1), lr = R[li], lx = 8;
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      var dd = new Date(aligned.times[li]);
      var when = state.timeFormat ? state.timeFormat(aligned.times[li])
        : MON[dd.getMonth()] + ' ' + dd.getDate() + ', ' + dd.getFullYear() + (intraday ? ' ' + ('0' + dd.getHours()).slice(-2) + ':' + ('0' + dd.getMinutes()).slice(-2) : '');
      ctx.fillStyle = th.muted; ctx.fillText(when, lx, 12); lx += ctx.measureText(when).width + 14;
      if (state.mode === 'candles' && lr.ohlc && lr.ohlc.o != null) {
        var o = lr.ohlc, txt = 'O ' + fmt(o.o) + '  H ' + fmt(o.h) + '  L ' + fmt(o.l) + '  C ' + fmt(o.c);
        ctx.fillStyle = o.c >= o.o ? th.up : th.down; ctx.fillText(txt, lx, 12); lx += ctx.measureText(txt).width + 14;
      }
      var names = state.mode === 'ratio' ? [(state.series[0].name || state.series[0].id) + ' / ' + (state.series[1] ? state.series[1].name || state.series[1].id : '?')]
        : state.series.map(function (s) { return s.name || s.id; });
      for (k = state.mode === 'candles' ? 1 : 0; k < nSeries; k++) {
        var lvv = lr.vals[k], label = names[k] + ' ' + (lvv == null ? '–' : fmt(lvv));
        if (lx + ctx.measureText(label).width > pw) break;
        ctx.fillStyle = seriesColor(k); ctx.fillRect(lx, 8, 8, 8); ctx.fillStyle = th.text; ctx.fillText(label, lx + 12, 12);
        lx += ctx.measureText(label).width + 26;
      }
    }

    function seriesColor(k) { var s = state.series[k]; return (s && s.color) || PALETTE[k % PALETTE.length]; }

    function idxAt(px) { return Math.round(view.end + 0.5 - (plotW() - px) / view.cw); }   // inverse of x(i)

    // ── interaction ──
    function pos(e) { var b = cv.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; }
    cv.addEventListener('pointerdown', function (e) { if (!view) return; cv.setPointerCapture(e.pointerId); drag = { x: pos(e).x, end: view.end }; });
    cv.addEventListener('pointermove', function (e) {
      if (!view) return;
      var p = pos(e);
      if (drag && !pinch) { view.end = drag.end - (p.x - drag.x) / view.cw; }
      hover = p.x < plotW() ? idxAt(p.x) : null; draw();
    });
    cv.addEventListener('pointerup', function () { drag = null; });
    cv.addEventListener('pointerleave', function () { drag = null; hover = null; draw(); });
    cv.addEventListener('wheel', function (e) {
      if (!view) return; e.preventDefault();
      var p = pos(e), at = view.end - (plotW() - p.x) / view.cw, f = e.deltaY > 0 ? 0.88 : 1.14;
      view.cw *= f; view.end = at + (plotW() - p.x) / view.cw; dropRange(); draw();
    }, { passive: false });
    cv.addEventListener('dblclick', function () { dropRange(); resetView(); draw(); });
    cv.addEventListener('touchstart', function (e) { if (e.touches.length === 2 && view) { dropRange(); pinch = { d: Math.abs(e.touches[0].clientX - e.touches[1].clientX), cw: view.cw }; } }, { passive: true });
    cv.addEventListener('touchmove', function (e) { if (pinch && e.touches.length === 2) { view.cw = pinch.cw * Math.abs(e.touches[0].clientX - e.touches[1].clientX) / (pinch.d || 1); draw(); } }, { passive: true });
    cv.addEventListener('touchend', function () { pinch = null; });
    var ro = root.ResizeObserver ? new ResizeObserver(function () { draw(); }) : null;
    if (ro) ro.observe(cv); else root.addEventListener('resize', draw);
    var mq = root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)');
    if (mq && mq.addEventListener) mq.addEventListener('change', draw);

    var api = {
      setData: function (d) {
        state.mode = d.mode || 'line';
        raw = (d.series || []).filter(function (s) { return s && s.data && s.data.length; })
          .map(function (s) { return Object.assign({}, s, { data: s.data.slice().sort(function (a, b) { return a.t - b.t; }) }); });
        state.lines = d.lines || []; state.bands = d.bands || null; state.volume = !!d.volume; state.format = d.format || null;
        state.timeFormat = d.timeFormat || null;
        rawStep = (d.rate && ivMs(d.rate)) || (raw[0] ? stepOf(raw[0].data) : DAY);
        rebuild();
        cv.setAttribute('aria-label', (state.series.map(function (s) { return s.name || s.id; }).join(', ') || 'Empty') + ' chart');
        if (!d.keepView) view = null;
        hover = null; paintBar(); draw();
        return api;
      },
      redraw: draw,
      resetView: function () { dropRange(); resetView(); draw(); },
      /** The controls' choices, e.g. to remember them: { interval, range }. */
      choices: function () { return { interval: interval, range: range }; },
      canvas: cv,
      destroy: function () { if (ro) ro.disconnect(); cv.remove(); },
    };
    return api;
  }

  root.ArciumChart = { create: create, palette: PALETTE, version: '1.1.0' };
})(typeof window !== 'undefined' ? window : this);
