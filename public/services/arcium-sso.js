/* Sign in with Arcium (see hub_core/sso.py). Used by the Trader page and the Arcade.
   ArciumSSO.start()  -> off to the Arcium account site, which comes back with a pass.
   ArciumSSO.finish() -> Promise of a fusionhub sign-in ({token, email, role}) when this page
                         was opened with a pass, otherwise null.
   .pw-retire elements get the date password sign-in ends (PASSWORD_LOGIN_UNTIL); after it,
   .pw-login elements (the password forms) are hidden.
   A page opened with ?sso=1 (the Arcium app switcher's links) starts the sign-in by itself, so
   someone already signed in to their Arcium account arrives signed in here too. */
(function () {
  'use strict';
  var STATE_KEY = 'arcium_sso_state';
  var status = fetch('/v1/status').then(function (r) { return r.json(); }).catch(function () { return {}; });
  var ssoUrl = status.then(function (j) { return (j.ssoUrl || 'https://app.arciumsignals.com').replace(/\/$/, ''); });
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  status.then(function (j) {
    var until = j.passwordLoginUntil;
    if (!until) return;
    var nice = MONTHS[Number(until.slice(5, 7)) - 1] + ' ' + Number(until.slice(8, 10)) + ', ' + until.slice(0, 4);
    var over = new Date().toISOString().slice(0, 10) >= until;
    function apply() {
      document.querySelectorAll('.pw-retire').forEach(function (el) {
        el.textContent = 'Password sign-in ends on ' + nice + '. After that, use Sign in with Arcium with the same email.';
      });
      if (over) document.querySelectorAll('.pw-login').forEach(function (el) { el.hidden = true; });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply); else apply();
  });

  function randomState() {
    var a = new Uint8Array(18);
    crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  window.ArciumSSO = {
    url: function () { return ssoUrl; },
    start: function () {
      var state = randomState();
      try { sessionStorage.setItem(STATE_KEY, state); } catch (e) {}
      ssoUrl.then(function (base) {
        location.href = base + '/sso?client=fusionhub&return=' +
          encodeURIComponent(location.origin + location.pathname) + '&state=' + state;
      });
    },
    finish: function () {
      var h = new URLSearchParams(location.hash.slice(1));
      var pass = h.get('arcium_pass');
      if (!pass) return Promise.resolve(null);
      history.replaceState(null, '', location.pathname + location.search);  // the pass leaves the address bar
      var expected = null;
      try { expected = sessionStorage.getItem(STATE_KEY); sessionStorage.removeItem(STATE_KEY); } catch (e) {}
      if (!expected || h.get('state') !== expected) {
        return Promise.reject({ error: 'That sign-in did not start here. Try "Sign in with Arcium" again.' });
      }
      return fetch('/v1/auth/sso', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                     body: JSON.stringify({ pass: pass }) })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw j; return j; }); });
    },
  };

  // start() returns to the bare path, so the ?sso=1 does not come back and this runs once.
  if (new URLSearchParams(location.search).get('sso') === '1' && !/arcium_pass=/.test(location.hash)) {
    window.ArciumSSO.start();
  }
})();
