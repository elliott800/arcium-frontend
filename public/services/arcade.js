/* Arcium Arcade: practice accounts trading forex, stocks and options at live prices. */
(function () {
  'use strict';
  var TOKEN_KEY = 'fh_token';
  var token = null, me = null, accountId = null, inst = null, kind = null, chain = null, pick = null;
  try { token = localStorage.getItem(TOKEN_KEY); accountId = +localStorage.getItem('arcade_account') || null; } catch (e) {}
  var $ = function (id) { return document.getElementById(id); };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function money(v) { return v == null ? '' : (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function px(v, k) { if (v == null) return ''; var d = k === 'forex' ? (v > 20 ? 3 : 5) : 2; return Number(v).toFixed(d); }
  function signed(v, suffix) { if (v == null) return ''; var c = v > 0 ? 'up' : v < 0 ? 'down' : ''; return '<span class="' + c + '">' + (v > 0 ? '+' : '') + (suffix === '%' ? v.toFixed(2) + '%' : money(v)) + '</span>'; }
  function errText(e) { return (e && (e.error || e.message)) || 'Something went wrong.'; }

  function api(path, body) {
    var h = { 'Content-Type': 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    return fetch(path, { method: body ? 'POST' : 'GET', headers: h, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().then(function (j) { if (r.status === 401) signOut(); if (!r.ok) throw j; return j; }); });
  }
  function tool(route, body) { return api('/v1/tools/arcade/' + route, body); }

  // ------------------------------------------------------------ sign in
  function signOut() {
    if (token) fetch('/v1/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }).catch(function () {});
    token = null; me = null;
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
    $('login').hidden = false; $('game').hidden = true; $('ticker').hidden = true; $('who').innerHTML = '';
  }
  $('login').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var f = ev.target;
    $('loginError').textContent = '';
    api('/v1/auth/login', { email: f.email.value, password: f.password.value }).then(function (j) {
      token = j.token; try { localStorage.setItem(TOKEN_KEY, token); } catch (e) {}
      start();
    }).catch(function (e) { $('loginError').textContent = errText(e); });
  });

  $('ssoBtn').onclick = function () { ArciumSSO.start(); };
  ArciumSSO.url().then(function (u) { document.querySelectorAll('.sso-signup').forEach(function (a) { a.href = u + '/signup'; }); });

  function start() {
    if (!token) return signOut();
    api('/v1/me').then(function (u) {
      me = u;
      $('login').hidden = true; $('game').hidden = false; $('ticker').hidden = false;
      $('who').innerHTML = '<span class="email">' + esc(me.email) + '</span> <button type="button" id="signout">Sign out</button>';
      $('signout').onclick = signOut;
      loadBanner(); loadAccounts();
    }).catch(signOut);
  }

  // ------------------------------------------------------------ banner
  function loadBanner() {
    tool('banner').then(function (j) {
      var chips = j.instruments.map(function (i) {
        var ch = i.changePct == null ? '' : '<span class="' + (i.changePct >= 0 ? 'up' : 'down') + '">' + (i.changePct >= 0 ? '+' : '') + Number(i.changePct).toFixed(2) + '%</span>';
        return '<button type="button" class="chip" data-sym="' + esc(i.symbol) + '" data-kind="' + i.kind + '"><b>' + esc(i.label) + '</b> ' + px(i.price, i.kind) + ' ' + ch + '</button>';
      }).join('');
      $('tickerTrack').innerHTML = chips + chips.replace(/class="chip"/g, 'class="chip dup"');   // doubled so the scroll loops seamlessly
      $('tickerTrack').querySelectorAll('.chip').forEach(function (c) {
        c.onclick = function () { select(c.dataset.sym); };
      });
    }).catch(function () {});
  }

  // ------------------------------------------------------------ accounts
  function loadAccounts() {
    tool('accounts').then(function (j) {
      var sel = $('account');
      if (!j.accounts.length) {
        sel.innerHTML = '<option value="">No accounts yet: create one below</option>';
        document.querySelector('.new-account').open = true;
        accountId = null; $('stats').innerHTML = ''; $('positions').innerHTML = '';
        return;
      }
      if (!j.accounts.some(function (a) { return a.id === accountId; })) accountId = j.accounts[0].id;
      sel.innerHTML = j.accounts.map(function (a) {
        return '<option value="' + a.id + '"' + (a.id === accountId ? ' selected' : '') + '>' + esc(a.name) + ' · ' + money(a.startBalance) + '</option>';
      }).join('');
      loadPositions();
    }).catch(function (e) { $('accountError').textContent = errText(e); });
  }
  $('account').onchange = function () { accountId = +this.value; try { localStorage.setItem('arcade_account', accountId); } catch (e) {} loadPositions(); };
  $('newAccount').onsubmit = function (ev) {
    ev.preventDefault();
    var f = ev.target;
    $('accountError').textContent = '';
    tool('accounts', { name: f.name.value, balance: f.balance.value.replace(/[$,\s]/g, '') }).then(function (j) {
      var last = j.accounts[j.accounts.length - 1];
      accountId = last.id; try { localStorage.setItem('arcade_account', accountId); } catch (e) {}
      f.reset(); document.querySelector('.new-account').open = false;
      loadAccounts();
    }).catch(function (e) { $('accountError').textContent = errText(e); });
  };

  // ------------------------------------------------------------ ticket
  $('anySymbol').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && this.value.trim()) { select(this.value.trim().toUpperCase()); this.value = ''; }
  });

  function select(sym) {
    $('orderError').textContent = '';
    document.querySelectorAll('.chip').forEach(function (c) { c.classList.toggle('on', c.dataset.sym === sym); });
    tool('quote?symbol=' + encodeURIComponent(sym)).then(function (q) {
      inst = q;
      $('tSym').textContent = q.label;
      $('tSpot').textContent = px(q.price, q.kind);
      var kinds = q.kind === 'forex' ? ['forex'] : ['stock', 'option'];
      $('kinds').innerHTML = kinds.map(function (k) { return '<button type="button" data-k="' + k + '">' + (k === 'forex' ? 'Forex' : k === 'stock' ? 'Shares' : 'Options') + '</button>'; }).join('');
      $('kinds').querySelectorAll('button').forEach(function (b) { b.onclick = function () { setKind(b.dataset.k); }; });
      setKind(kinds[0]);
    }).catch(function (e) { $('orderError').textContent = errText(e); });
  }

  function defaultExpiry() {
    var d = new Date(Date.now() + 7 * 86400000);
    return d.toISOString().slice(0, 10);
  }

  function setKind(k) {
    kind = k; chain = null; pick = null;
    $('kinds').querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b.dataset.k === k); });
    var o = $('order');
    o.hidden = false;
    if (k === 'option') {
      o.innerHTML = '<div class="row"><label>Expiration <select name="expiration"></select></label>' +
        '<label>Right <span class="seg" id="right"><button type="button" data-v="call" class="on">Call</button><button type="button" data-v="put">Put</button></span></label>' +
        '<label>Contracts <input name="qty" value="1" inputmode="numeric" style="width:90px"></label></div>' +
        '<div class="chain" id="chain"><p class="muted" style="padding:10px">Loading the chain…</p></div>' +
        '<div class="preview" id="preview">Pick a strike.</div><div><button class="btn" type="submit">Buy</button></div>';
      segment('right', loadChain);
      tool('options?symbol=' + encodeURIComponent(inst.symbol)).then(function (j) {
        o.expiration.innerHTML = j.expirations.map(function (e) { return '<option>' + esc(e) + '</option>'; }).join('');
        o.expiration.onchange = loadChain;
        loadChain();
      }).catch(function (e) { $('chain').innerHTML = '<p class="error" style="padding:10px">' + esc(errText(e)) + '</p>'; });
    } else {
      var unit = k === 'forex' ? 'Units' : 'Shares';
      o.innerHTML = '<div class="row"><label>Side <span class="seg" id="side"><button type="button" data-v="long" class="on">Long</button><button type="button" data-v="short">Short</button></span></label>' +
        '<label>' + unit + ' <input name="qty" value="' + (k === 'forex' ? '10000' : '10') + '" inputmode="numeric" style="width:120px"></label>' +
        '<label>Expires <input type="date" name="expires" value="' + defaultExpiry() + '"></label></div>' +
        '<div class="preview" id="preview"></div><div><button class="btn" type="submit">Open position</button></div>';
      segment('side', preview);
      o.qty.oninput = preview;
      preview();
    }
  }

  function segment(id, onchange) {
    $(id).querySelectorAll('button').forEach(function (b) {
      b.onclick = function () {
        $(id).querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); });
        onchange();
      };
    });
  }
  function segValue(id) { var b = $(id).querySelector('.on'); return b && b.dataset.v; }

  function preview() {
    var o = $('order'), q = +o.qty.value || 0, side = segValue('side');
    var text;
    if (kind === 'forex') {
      var usdBase = inst.symbol.indexOf('USD') === 0;
      var notional = usdBase ? q : q * inst.price;
      text = 'Notional <b>' + money(notional) + '</b> · margin at 50:1 <b>' + money(notional / 50) + '</b>';
    } else {
      var cost = q * inst.price;
      text = side === 'long' ? 'Cost <b>' + money(cost) + '</b>' : 'Short proceeds ' + money(cost) + ' · margin held <b>' + money(cost * 0.5) + '</b>';
    }
    $('preview').innerHTML = text + ' · closes at the expiry date\'s close unless you close it first.';
  }

  function loadChain() {
    var o = $('order'), right = segValue('right');
    pick = null;
    $('preview').textContent = 'Pick a strike.';
    $('chain').innerHTML = '<p class="muted" style="padding:10px">Loading…</p>';
    tool('options?symbol=' + encodeURIComponent(inst.symbol) + '&expiration=' + encodeURIComponent(o.expiration.value)).then(function (j) {
      chain = j;
      var rows = j[right === 'call' ? 'calls' : 'puts'];
      $('chain').innerHTML = '<table><thead><tr><th class="num">Strike</th><th class="num">Bid</th><th class="num">Ask</th><th class="num">Last</th></tr></thead><tbody>' +
        rows.map(function (r, i) {
          var itm = right === 'call' ? r.strike < j.spot : r.strike > j.spot;
          return '<tr class="strike-row" data-i="' + i + '"><td class="num' + (itm ? ' up' : '') + '">' + r.strike + '</td><td class="num">' + px(r.bid) +
            '</td><td class="num">' + px(r.ask) + '</td><td class="num">' + px(r.last) + '</td></tr>';
        }).join('') + '</tbody></table>';
      $('chain').querySelectorAll('.strike-row').forEach(function (tr) {
        tr.onclick = function () {
          $('chain').querySelectorAll('.strike-row').forEach(function (x) { x.classList.toggle('on', x === tr); });
          pick = rows[+tr.dataset.i];
          var qn = +o.qty.value || 0, prem = (pick.ask || pick.last || 0) * 100 * qn;
          $('preview').innerHTML = esc(inst.symbol + ' ' + o.expiration.value + ' ' + pick.strike + ' ' + right) + ' · premium <b>' + money(prem) +
            '</b> (' + qn + ' × 100 × ' + px(pick.ask || pick.last) + ') · settles at intrinsic value on expiration';
        };
      });
      var mid = rows.reduce(function (best, r, i) { return Math.abs(r.strike - j.spot) < Math.abs(rows[best].strike - j.spot) ? i : best; }, 0);
      var midRow = $('chain').querySelector('[data-i="' + mid + '"]');
      if (midRow) midRow.scrollIntoView({ block: 'center' });
    }).catch(function (e) { $('chain').innerHTML = '<p class="error" style="padding:10px">' + esc(errText(e)) + '</p>'; });
  }

  $('order').addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (!accountId) { $('orderError').textContent = 'Create an account first.'; return; }
    var o = ev.target, body = { account_id: accountId, kind: kind, symbol: inst.symbol, qty: o.qty.value };
    if (kind === 'option') {
      if (!pick) { $('orderError').textContent = 'Pick a strike first.'; return; }
      body.right = segValue('right'); body.expiration = o.expiration.value; body.strike = pick.strike;
    } else {
      body.side = segValue('side'); body.expires = o.expires.value;
    }
    $('orderError').textContent = '';
    o.querySelector('button[type=submit]').disabled = true;
    tool('open', body).then(function (j) { renderPositions(j); })
      .catch(function (e) { $('orderError').textContent = errText(e); })
      .then(function () { var b = o.querySelector('button[type=submit]'); if (b) b.disabled = false; });
  });

  // ------------------------------------------------------------ positions
  function loadPositions() {
    if (!accountId) return;
    tool('positions?account_id=' + accountId).then(renderPositions).catch(function (e) { $('positions').innerHTML = '<p class="error">' + esc(errText(e)) + '</p>'; });
  }

  function renderPositions(j) {
    var a = j.account;
    $('stats').innerHTML = [['Equity', money(a.equity)], ['Cash', money(a.cash)], ['Held', money(a.held)],
      ['Open P/L', signed(a.unrealized)], ['Return', signed(a.returnPct, '%')]]
      .map(function (s) { return '<div><span>' + s[0] + '</span>' + s[1] + '</div>'; }).join('');
    if (!j.positions.length) { $('positions').innerHTML = '<p class="muted">No positions yet. Pick an instrument from the banner.</p>'; return; }
    $('positions').innerHTML = '<table><thead><tr><th>Instrument</th><th>Side</th><th class="num">Qty</th><th class="num">Open</th>' +
      '<th class="num">Now / close</th><th>Expires</th><th>Status</th><th class="num">P/L</th><th></th></tr></thead><tbody>' +
      j.positions.map(function (p) {
        var open = p.status === 'open', k = p.kind;
        return '<tr><td>' + esc(p.label) + '</td><td><span class="pill ' + p.side + '">' + p.side + '</span></td><td class="num">' + p.qty.toLocaleString() +
          '</td><td class="num">' + px(p.openPrice, k) + '</td><td class="num">' + px(open ? p.mark : p.closePrice, k) + '</td><td>' + esc(p.expires) +
          '</td><td>' + esc(p.status) + '</td><td class="num">' + signed(open ? p.unrealized : p.pnl) + '</td><td>' +
          (open ? '<button class="btn ghost small" data-close="' + p.id + '">Close</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table>';
    $('positions').querySelectorAll('[data-close]').forEach(function (b) {
      b.onclick = function () {
        b.disabled = true;
        tool('close', { position_id: +b.dataset.close }).then(renderPositions).catch(function (e) { b.disabled = false; alert(errText(e)); });
      };
    });
  }

  setInterval(function () { if (me && accountId && !document.hidden) loadPositions(); }, 30000);
  // Coming back from "Sign in with Arcium": trade the pass for a sign-in first.
  ArciumSSO.finish().then(function (j) {
    if (j) { token = j.token; try { localStorage.setItem(TOKEN_KEY, token); } catch (e) {} }
    start();
  }).catch(function (e) { start(); $('loginError').textContent = errText(e); });
})();
