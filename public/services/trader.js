/* Trader page: one signed-in user's desk on top of FUll SCAN.
   Views follow the trading workbook: Home -> Fundamentals -> Events -> Tickers -> Schedule,
   then the user's Predictions, their own settings, and (admin) FUll SCAN's settings. */
(function () {
  'use strict';
  var TOKEN_KEY = 'fh_token';
  var token = null, me = null, trading = null;
  try { token = localStorage.getItem(TOKEN_KEY); } catch (e) {}

  var $ = function (id) { return document.getElementById(id); };
  var view = $('view');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(v, d) { return v == null || isNaN(v) ? '' : Number(v).toLocaleString(undefined, { minimumFractionDigits: d == null ? 2 : d, maximumFractionDigits: d == null ? 2 : d }); }
  function pct(v, d) { return v == null || isNaN(v) ? '' : num(v * 100, d == null ? 1 : d) + '%'; }
  function signed(v, d, suffix) {
    if (v == null || isNaN(v)) return '';
    var cls = v > 0 ? 'pos' : v < 0 ? 'neg' : '';
    return '<span class="' + cls + '">' + (v > 0 ? '+' : '') + num(v, d) + (suffix || '') + '</span>';
  }

  function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    return fetch(path, { method: opts.method || 'GET', headers: headers,
                         body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function (r) {
        if (opts.raw) return r.ok ? r : r.json().then(function (j) { throw j; });
        return r.json().then(function (j) {
          if (r.status === 401) { signOut(); }
          if (!r.ok) throw j;
          return j;
        });
      });
  }
  function tool(route, opts) { return api('/v1/tools/trader/' + route, opts); }
  function errText(e) { return (e && (e.error || e.message)) || 'Something went wrong.'; }

  // ---------------------------------------------------------------- sign in / out
  function showLogin() { $('login').hidden = false; $('tabs').hidden = true; view.innerHTML = ''; $('who').innerHTML = ''; }
  function signOut() {
    if (token) api('/v1/auth/logout', { method: 'POST' }).catch(function () {});
    token = null; me = null;
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
    showLogin();
  }
  $('login').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var f = ev.target;
    $('loginError').textContent = '';
    api('/v1/auth/login', { method: 'POST', body: { email: f.email.value, password: f.password.value } })
      .then(function (j) {
        token = j.token;
        try { localStorage.setItem(TOKEN_KEY, token); } catch (e) {}
        start();
      })
      .catch(function (e) { $('loginError').textContent = errText(e); });
  });

  $('ssoBtn').onclick = function () { ArciumSSO.start(); };
  ArciumSSO.url().then(function (u) { document.querySelectorAll('.sso-signup').forEach(function (a) { a.href = u + '/signup'; }); });

  function start() {
    if (!token) return showLogin();
    api('/v1/me').then(function (u) {
      me = u;
      $('login').hidden = true;
      $('tabs').hidden = false;
      document.querySelectorAll('[data-admin]').forEach(function (a) { a.hidden = me.role !== 'admin'; });
      $('who').innerHTML = esc(me.email) + ' <button type="button" id="signout">Sign out</button>';
      $('signout').onclick = signOut;
      route();
    }).catch(showLogin);
  }

  // ---------------------------------------------------------------- data
  function loadTrading() {
    if (trading) return Promise.resolve(trading);
    return api('/v1/tools/full-scan/data?workbook=trading').then(function (j) {
      trading = j.sections || j;
      return trading;
    });
  }
  function title(text, asof, sub) {
    return '<h2 class="view-title">' + esc(text) + '</h2><p class="asof">' +
      (asof ? 'As of ' + esc(asof) : esc(sub || '')) + '</p>';
  }
  function table(cols, rows, opts) {
    opts = opts || {};
    var h = '<table class="data"><thead><tr>' + cols.map(function (c) {
      return '<th' + (c.num ? ' class="num"' : '') + '>' + esc(c.label) + '</th>';
    }).join('') + '</tr></thead><tbody>';
    h += rows.map(function (r, i) {
      return '<tr' + (opts.click ? ' class="click" data-i="' + i + '"' : '') + '>' + cols.map(function (c) {
        return '<td' + (c.num ? ' class="num"' : '') + '>' + c.cell(r) + '</td>';
      }).join('') + '</tr>';
    }).join('');
    h += '</tbody>' + (opts.foot || '') + '</table>';
    return h;
  }
  function loading() { view.innerHTML = '<p class="asof">Loading…</p>'; }
  function fail(e) { view.innerHTML = '<p class="error">' + esc(errText(e)) + '</p>'; }

  // ---------------------------------------------------------------- Home (Main dashboard)
  function home() {
    loading();
    loadTrading().then(function (t) {
      var d = t.dashboard || {}, c = d.crisis || {};
      var h = title('Home', (d.run_time || '').replace('T', ' ').slice(0, 16));
      h += '<div class="grid2">';
      h += '<div class="panel"><h3>Economy Scanner · crisis level <span class="level ' + esc(c.level) + '">' + esc(c.level || '—') + '</span></h3>' +
        table([
          { label: 'Indicator', cell: function (r) { return esc(r.indicator); } },
          { label: 'Value', num: true, cell: function (r) { return num(r.value); } },
          { label: 'Percentile', num: true, cell: function (r) { return pct(r.percentile, 0); } },
          { label: 'Status', cell: function (r) { return esc(r.status); } },
          { label: 'As of', cell: function (r) { return esc(r.asof); } }
        ], c.rows || []) + '</div>';
      h += '<div class="panel"><h3>Stock Scanner · this month\'s picks (' + esc(d.month || '') + ')</h3>' +
        table([
          { label: '', cell: function (r) { return '<span class="pill ' + esc(r.side) + '">' + esc(r.side) + '</span>'; } },
          { label: 'Ticker', cell: function (r) { return '<b>' + esc(r.ticker) + '</b>'; } },
          { label: 'Sector', cell: function (r) { return esc(r.sector); } },
          { label: 'Rank', num: true, cell: function (r) { return esc(r.rank) + ' / ' + esc(r.of); } },
          { label: 'Price', num: true, cell: function (r) { return num(r.price); } },
          { label: 'Next', cell: function (r) { return esc(r.next_type || '') + ' ' + esc(r.next_date || ''); } },
          { label: 'Days', num: true, cell: function (r) { return esc(r.days_until == null ? '' : r.days_until); } }
        ], d.assets || []) + '</div>';
      h += '</div><div class="panel" style="margin-top:16px"><h3>Next 14 days</h3>' +
        table([
          { label: 'Date', cell: function (r) { return esc(r.date); } },
          { label: 'Ticker', cell: function (r) { return '<b>' + esc(r.ticker) + '</b>'; } },
          { label: 'Event', cell: function (r) { return esc((r.type || '').replace('_', ' ')); } },
          { label: 'Status', cell: function (r) { return esc(r.status); } },
          { label: 'Detail', cell: function (r) { return esc(r.figure || r.summary || ''); } }
        ], d.upcoming || []) + '</div>';
      h += '<p class="asof" style="margin-top:14px"><a href="#fundamentals">Fundamentals &rarr;</a></p>';
      view.innerHTML = h;
    }).catch(fail);
  }

  // ---------------------------------------------------------------- Fundamentals (Rank dashboard)
  function fundamentals() {
    loading();
    loadTrading().then(function (t) {
      var r = t.rank || {}, recs = (r.records || []).slice().sort(function (a, b) { return (a.rank || 999) - (b.rank || 999); });
      var upside = function (x) { return x.est_median && x.price ? x.est_median / x.price - 1 : null; };
      var h = title('Fundamentals', r.as_of);
      h += '<div class="panel">' + table([
        { label: 'Rank', num: true, cell: function (x) { return esc(x.rank); } },
        { label: 'Ticker', cell: function (x) { return '<b>' + esc(x.ticker) + '</b>'; } },
        { label: 'Name', cell: function (x) { return esc(x.name); } },
        { label: 'Sector', cell: function (x) { return esc(x.sector); } },
        { label: 'Verdict', cell: function (x) { return esc(x.verdict || ''); } },
        { label: 'Price', num: true, cell: function (x) { return num(x.price); } },
        { label: 'Fair value', num: true, cell: function (x) { return num(x.est_median); } },
        { label: 'Range', num: true, cell: function (x) { return x.est_min == null ? '' : num(x.est_min) + ' – ' + num(x.est_max); } },
        { label: 'Upside', num: true, cell: function (x) { var u = upside(x); return u == null ? '' : signed(u * 100, 1, '%'); } },
        { label: 'P/E', num: true, cell: function (x) { return num(x.pe, 1); } },
        { label: 'ROE', num: true, cell: function (x) { return pct(x.roe); } },
        { label: 'Growth', num: true, cell: function (x) { return pct(x.growth); } },
        { label: 'Debt', num: true, cell: function (x) { return pct(x.debt_ratio, 0); } },
        { label: 'EV/EBITDA', num: true, cell: function (x) { return num(x.ev_ebitda, 1); } },
        { label: 'Analyst target', num: true, cell: function (x) { return num(x.analyst_mean); } }
      ], recs, { click: true }) + '</div><div class="detail" id="detail"></div>';
      view.innerHTML = h;
      view.querySelectorAll('tr.click').forEach(function (tr) {
        tr.onclick = function () { detail(recs[+tr.dataset.i]); };
      });
    }).catch(fail);
  }
  function detail(x) {
    var fields = [
      ['Price', num(x.price)], ['52-week high', num(x.high_1y)], ['EPS (ttm)', num(x.eps_ttm)],
      ['EPS (forward)', num(x.eps_forward)], ['P/E', num(x.pe, 1)], ['P/E range', num(x.pe_min, 1) + ' – ' + num(x.pe_max, 1)],
      ['Peer group', esc(x.peer_group || '')], ['Fair value (median)', num(x.est_median)],
      ['Fair value range', num(x.est_min) + ' – ' + num(x.est_max)], ['DCF value', num(x.dcf_value)],
      ['Price to book', num(x.price_to_book, 1)], ['PEG', num(x.peg, 2)], ['Revenue growth', pct(x.revenue_growth)],
      ['Quick ratio', num(x.quick_ratio)], ['Current ratio', num(x.current_ratio)],
      ['Analysts (low / mean / high)', num(x.analyst_low) + ' / ' + num(x.analyst_mean) + ' / ' + num(x.analyst_high)],
      ['Industry', esc(x.industry || '')], ['Data as of', esc((x.fetched_at || '').slice(0, 10))]
    ];
    $('detail').innerHTML = '<div class="panel"><h3>' + esc(x.ticker) + ' · ' + esc(x.name) + '</h3><div class="kv">' +
      fields.map(function (f) { return '<div><span>' + esc(f[0]) + '</span>' + f[1] + '</div>'; }).join('') + '</div></div>';
    $('detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ---------------------------------------------------------------- Events
  function events() {
    loading();
    loadTrading().then(function (t) {
      var e = t.events || {}, all = e.events || [];
      var types = Array.from(new Set(all.map(function (x) { return x.type; }))).sort();
      var h = title('Events', e.as_of) + '<div class="toolbar-row"><select id="etype"><option value="">All events</option>' +
        types.map(function (x) { return '<option>' + esc(x) + '</option>'; }).join('') +
        '</select><input type="search" id="eq" placeholder="Ticker"></div><div class="panel" id="elist"></div>';
      view.innerHTML = h;
      function draw() {
        var ty = $('etype').value, q = $('eq').value.trim().toUpperCase();
        var rows = all.filter(function (x) { return (!ty || x.type === ty) && (!q || (x.ticker || '').indexOf(q) === 0); })
          .sort(function (a, b) { return (a.date || '').localeCompare(b.date || ''); });
        $('elist').innerHTML = table([
          { label: 'Date', cell: function (x) { return esc(x.date); } },
          { label: 'Ticker', cell: function (x) { return '<b>' + esc(x.ticker) + '</b>'; } },
          { label: 'Event', cell: function (x) { return esc((x.type || '').replace('_', ' ')); } },
          { label: 'Status', cell: function (x) { return esc(x.status); } },
          { label: 'Detail', cell: function (x) { return esc(x.figure || x.summary || ''); } },
          { label: 'Source', cell: function (x) { return x.url ? '<a href="' + esc(x.url) + '" target="_blank" rel="noopener">link</a>' : ''; } }
        ], rows);
      }
      $('etype').onchange = draw; $('eq').oninput = draw; draw();
    }).catch(fail);
  }

  // ---------------------------------------------------------------- Tickers
  function tickers() {
    loading();
    loadTrading().then(function (t) {
      var tk = t.tickers || {}, sectors = tk.sectors || {}, names = Object.keys(sectors);
      var h = title('Tickers', tk.as_of) + '<div class="toolbar-row"><select id="sector">' +
        names.map(function (n) { return '<option>' + esc(n) + '</option>'; }).join('') + '</select></div><div class="panel" id="tlist"></div>';
      view.innerHTML = h;
      function draw() {
        var rows = (sectors[$('sector').value] || {}).rows || [];
        $('tlist').innerHTML = table([
          { label: 'Rank', num: true, cell: function (x) { return esc(x.rank); } },
          { label: 'Ticker', cell: function (x) { return '<b>' + esc(x.ticker) + '</b>'; } },
          { label: 'Name', cell: function (x) { return esc(x.name); } },
          { label: 'Price', num: true, cell: function (x) { return num(x.spot); } },
          { label: 'Open interest', num: true, cell: function (x) { return num(x.total_oi, 0); } },
          { label: 'Option volume', num: true, cell: function (x) { return num(x.total_volume, 0); } },
          { label: 'ATM spread', num: true, cell: function (x) { return pct(x.atm_spread); } },
          { label: 'Expirations', num: true, cell: function (x) { return esc(x.expirations); } },
          { label: 'Market cap', num: true, cell: function (x) { return x.market_cap ? num(x.market_cap / 1e9, 1) + 'B' : ''; } }
        ], rows);
      }
      $('sector').onchange = draw; draw();
    }).catch(fail);
  }

  // ---------------------------------------------------------------- Schedule: my calendar vs FUll SCAN's
  function schedule() {
    loading();
    Promise.all([tool('calendar'), loadTrading()]).then(function (res) {
      var cal = res[0], t = res[1];
      var byDay = {};
      function add(list, side) {
        list.forEach(function (e) { (byDay[e.date] = byDay[e.date] || { mine: [], fs: [] })[side].push(e); });
      }
      add(cal.mine || [], 'mine'); add(cal.fullscan || [], 'fs');
      var days = Object.keys(byDay).sort(), today = new Date().toISOString().slice(0, 10);
      var h = title('Schedule', null, cal.from + ' to ' + cal.to);
      if (!cal.hasCalendar) h += '<p class="asof">Add your calendar\'s private iCal link in <a href="#profile">My settings</a> to see it here.</p>';
      if (cal.mineError) h += '<p class="error">' + esc(cal.mineError) + '</p>';
      h += '<div class="cal"><div class="head">Date</div><div class="head mine">My calendar</div><div class="head fs">Stock Scanner</div>';
      function evs(list) {
        return list.map(function (e) {
          var t = e.time ? '<small>' + esc(e.time) + '</small> ' : '';
          var link = e.url ? ' <a href="' + esc(e.url) + '" target="_blank" rel="noopener">↗</a>' : '';
          return '<span class="ev">' + t + esc(e.title) + (e.detail ? ' <small>' + esc(e.detail) + '</small>' : '') + link + '</span>';
        }).join('');
      }
      days.forEach(function (d) {
        h += '<div class="day' + (d === today ? ' today' : '') + '">' + esc(d) + '</div><div class="mine">' + evs(byDay[d].mine) +
          '</div><div class="fs">' + evs(byDay[d].fs) + '</div>';
      });
      if (!days.length) h += '<div class="day">—</div><div class="mine"></div><div class="fs"></div>';
      h += '</div>';
      // Long / short schedule by month
      var months = (t.schedule || {}).months || {};
      var keys = Object.keys(months).filter(function (k) { return months[k].status !== 'not generated'; }).sort();
      if (keys.length) {
        h += '<h3 style="margin:26px 0 10px">Long / short schedule</h3><div class="toolbar-row"><select id="month">' +
          keys.map(function (k) { return '<option' + (k === today.slice(0, 7) ? ' selected' : '') + '>' + esc(k) + '</option>'; }).join('') +
          '</select></div><div id="picks"></div>';
      }
      view.innerHTML = h;
      if (keys.length) {
        var draw = function () {
          var m = months[$('month').value];
          var rows = [];
          ['long', 'short'].forEach(function (side) {
            (m[side] || []).forEach(function (g) {
              (g.picks || []).forEach(function (p) { rows.push({ side: side, sector: g.sector, etf: g.etf, p: p }); });
            });
          });
          $('picks').innerHTML = '<div class="panel">' + table([
            { label: '', cell: function (r) { return '<span class="pill ' + r.side + '">' + r.side + '</span>'; } },
            { label: 'Sector', cell: function (r) { return esc(r.sector) + ' <small>' + esc(r.etf || '') + '</small>'; } },
            { label: 'Ticker', cell: function (r) { return '<b>' + esc(r.p.ticker) + '</b>'; } },
            { label: 'Name', cell: function (r) { return esc(r.p.name); } },
            { label: 'Rank', num: true, cell: function (r) { return esc(r.p.rank) + ' / ' + esc(r.p.of); } },
            { label: 'Price', num: true, cell: function (r) { return num(r.p.price); } }
          ], rows) + '</div>';
        };
        $('month').onchange = draw; draw();
      }
    }).catch(fail);
  }

  // ---------------------------------------------------------------- Predictions
  function predictions() {
    loading();
    tool('predictions').then(function (j) {
      var s = j.summary, rows = j.predictions;
      var tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      var h = title('Predictions', null, s.open + ' open, ' + s.scored + ' scored');
      h += '<form class="panel form" id="lockForm" style="max-width:none;margin-bottom:16px"><h3>Lock a prediction</h3>' +
        '<div class="toolbar-row"><input name="ticker" placeholder="Ticker" required style="width:110px">' +
        '<input name="targets" placeholder="Targets, e.g. 210, 225" required style="width:200px">' +
        '<label style="display:flex;gap:6px;align-items:center">until <input type="date" name="until" min="' + tomorrow + '" required></label>' +
        '<input name="note" placeholder="Note (optional)" style="flex:1;min-width:160px">' +
        '<button class="btn" type="submit">Lock</button></div>' +
        '<div class="hint">Locks the current price and, from your broker, your cash and its cash rate. A target is realized if the price touches it before the date.</div>' +
        '<div class="error" id="lockError"></div></form>';
      var foot = '<tfoot><tr><td colspan="6">Total (' + rows.length + ')</td><td class="num">' + signed(s.returnPctTotal, 2, '%') +
        '</td><td></td><td></td><td class="num">' + (s.loss ? '<span class="neg">' + num(s.loss) + '</span>' : '') + '</td><td></td></tr></tfoot>';
      h += '<div class="panel">' + table([
        { label: 'Locked', cell: function (p) { return esc(p.lockedAt.slice(0, 10)); } },
        { label: 'Ticker', cell: function (p) { return '<b>' + esc(p.ticker) + '</b>'; } },
        { label: 'Price', num: true, cell: function (p) { return num(p.refPrice); } },
        { label: 'Targets', cell: function (p) {
          return p.targets.map(function (t) { return '<span class="' + (t.hit_at ? 'pos' : '') + '" title="' + esc(t.hit_at ? 'hit ' + t.hit_at : 'not hit') + '">' + num(t.price) + '</span>'; }).join(', ');
        } },
        { label: 'Until', cell: function (p) { return esc(p.until); } },
        { label: 'Status', cell: function (p) { return '<span class="pill ' + esc(p.status) + '">' + esc(p.status) + (p.status === 'open' ? ' (so far)' : '') + '</span>'; } },
        { label: 'Return %', num: true, cell: function (p) { return signed(p.returnPct, 2, '%') + (p.missingCashRate && p.status !== 'open' ? ' <small title="no cash rate: unhit targets counted as 0%">*</small>' : ''); } },
        { label: 'Cash', num: true, cell: function (p) { return num(p.cash); } },
        { label: 'Cash rate', num: true, cell: function (p) { return pct(p.cashRate, 2); } },
        { label: 'Loss', num: true, cell: function (p) { return p.loss ? '<span class="neg">' + num(p.loss) + '</span>' : ''; } },
        { label: '', cell: function (p) { return p.status === 'open' ? '<button type="button" class="btn" data-del="' + p.id + '" style="padding:2px 8px">Remove</button>' : ''; } }
      ], rows, { foot: foot }) + '</div>' +
        '<p class="asof" style="margin-top:12px"><a href="#" id="exportLink">Download the predictions spreadsheet (.xlsx)</a></p>';
      view.innerHTML = h;
      $('lockForm').onsubmit = function (ev) {
        ev.preventDefault();
        var f = ev.target;
        $('lockError').textContent = '';
        tool('lock', { method: 'POST', body: { ticker: f.ticker.value, targets: f.targets.value, until: f.until.value, note: f.note.value } })
          .then(predictions).catch(function (e) { $('lockError').textContent = errText(e); });
      };
      view.querySelectorAll('[data-del]').forEach(function (b) {
        b.onclick = function () {
          if (!confirm('Remove this open prediction?')) return;
          tool('delete', { method: 'POST', body: { id: +b.dataset.del } }).then(predictions).catch(function (e) { alert(errText(e)); });
        };
      });
      $('exportLink').onclick = function (ev) {
        ev.preventDefault();
        api('/v1/tools/trader/export', { raw: true }).then(function (r) { return r.blob(); }).then(function (b) {
          var a = document.createElement('a');
          a.href = URL.createObjectURL(b);
          a.download = 'predictions-' + new Date().toISOString().slice(0, 10) + '.xlsx';
          a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
        }).catch(function (e) { alert(errText(e)); });
      };
    }).catch(fail);
  }

  // ---------------------------------------------------------------- My settings (the user's trader profile)
  function profile() {
    loading();
    tool('profile').then(function (j) {
      var s = j.settings, set = j.set;
      var keyField = function (name, label, hint) {
        return '<label>' + esc(label) + ' <input type="password" name="' + name + '" autocomplete="off" placeholder="' +
          (set[name] ? 'saved (leave blank to keep)' : 'not set') + '"><span class="hint">' + esc(hint || '') + '</span></label>';
      };
      view.innerHTML = title('My settings') +
        '<form class="form" id="profileForm">' +
        '<label>Broker <select name="broker">' + ['none', 'webull'].map(function (b) {
          return '<option' + (s.broker === b ? ' selected' : '') + '>' + b + '</option>';
        }).join('') + '</select><span class="hint">Where cash and the cash rate are read when you lock a prediction.</span></label>' +
        keyField('webull_app_key', 'Webull App Key', 'Saved for when Webull is connected.') + keyField('webull_app_secret', 'Webull App Secret') +
        '<label>Cash rate if the broker doesn\'t give one (% a year) <input name="cash_rate_fallback" inputmode="decimal" value="' +
        (s.cash_rate_fallback == null ? '' : num(s.cash_rate_fallback * 100, 2)) + '"></label>' +
        keyField('calendar_url', 'My calendar (private iCal link)', 'Google Calendar: Settings → your calendar → "Secret address in iCal format".') +
        '<button class="btn" type="submit">Save</button><div id="profileMsg"></div></form>';
      $('profileForm').onsubmit = function (ev) {
        ev.preventDefault();
        var f = ev.target, body = { broker: f.broker.value, cash_rate_fallback: f.cash_rate_fallback.value.trim() };
        ['webull_app_key', 'webull_app_secret', 'calendar_url'].forEach(function (k) {
          if (f[k].value.trim()) body[k] = f[k].value.trim();
        });
        tool('profile', { method: 'POST', body: body }).then(function () {
          profile();
          setTimeout(function () { var m = $('profileMsg'); if (m) m.innerHTML = '<span class="ok">Saved.</span>'; }, 50);
        }).catch(function (e) { $('profileMsg').innerHTML = '<span class="error">' + esc(errText(e)) + '</span>'; });
      };
    }).catch(fail);
  }

  // ---------------------------------------------------------------- FUll SCAN settings (admin)
  function settings() {
    loading();
    tool('settings').then(function (j) {
      var h = title('Scanner settings') + '<p class="asof">Changes apply from the scanners\' next run.</p>';
      var group = null;
      j.processes.forEach(function (p) {
        if (p.group !== group) { group = p.group; h += '<h3 style="margin:22px 0 10px">' + esc(group) + '</h3>'; }
        h += '<details class="process"><summary>' + esc(p.title) + ' <small class="asof">(' + p.settings.length + ')</small></summary><div class="rows">' +
          (p.note ? '<p class="asof" style="margin:4px 0 8px">' + esc(p.note) + '</p>' : '');
        p.settings.forEach(function (s) {
          var val = s.editable
            ? (s.type === 'bool'
              ? '<select data-key="' + esc(s.key) + '" data-old="' + s.value + '"><option' + (s.value ? ' selected' : '') + '>true</option><option' + (!s.value ? ' selected' : '') + '>false</option></select>'
              : '<input data-key="' + esc(s.key) + '" data-old="' + esc(s.value) + '" value="' + esc(s.value) + '">')
            : '<code>' + esc(JSON.stringify(s.value)) + '</code>';
          h += '<div class="setting"><div><code>' + esc(s.section) + '</code> ' + esc(s.name) + '</div><div>' + val + '</div>' +
            (s.note ? '<div class="note">' + esc(s.note) + '</div>' : '') + '</div>';
        });
        h += '</div></details>';
      });
      h += '<div class="toolbar-row" style="margin-top:14px"><button class="btn" id="saveSettings">Save changes</button><span id="settingsMsg"></span></div>';
      view.innerHTML = h;
      $('saveSettings').onclick = function () {
        var changes = {};
        view.querySelectorAll('[data-key]').forEach(function (el) {
          if (String(el.value) !== String(el.dataset.old)) changes[el.dataset.key] = el.value;
        });
        if (!Object.keys(changes).length) { $('settingsMsg').innerHTML = '<span class="asof">No changes.</span>'; return; }
        tool('settings', { method: 'POST', body: { changes: changes } }).then(function (r) {
          settings();
          setTimeout(function () { var m = $('settingsMsg'); if (m) m.innerHTML = '<span class="ok">Saved ' + r.changed.length + ' setting(s).</span>'; }, 50);
        }).catch(function (e) { $('settingsMsg').innerHTML = '<span class="error">' + esc(errText(e)) + '</span>'; });
      };
    }).catch(fail);
  }

  // ---------------------------------------------------------------- routing
  var VIEWS = { home: home, fundamentals: fundamentals, events: events, tickers: tickers, schedule: schedule,
                predictions: predictions, profile: profile, settings: settings };
  function route() {
    if (!me) return;
    var name = (location.hash || '#home').slice(1);
    if (!VIEWS[name] || (name === 'settings' && me.role !== 'admin')) name = 'home';
    document.querySelectorAll('#tabs a').forEach(function (a) {
      if (a.getAttribute('href') === '#' + name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    VIEWS[name]();
  }
  window.addEventListener('hashchange', route);
  // Coming back from "Sign in with Arcium": trade the pass for a sign-in first.
  ArciumSSO.finish().then(function (j) {
    if (j) { token = j.token; try { localStorage.setItem(TOKEN_KEY, token); } catch (e) {} }
    start();
  }).catch(function (e) { start(); $('loginError').textContent = errText(e); });
})();
