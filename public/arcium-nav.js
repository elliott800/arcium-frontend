/* The Arcium bar: one script every Arcium site loads, so every site has the same way to every
   dashboard. app.arciumsignals.com is the one sign-in; the menu comes from its /api/nav.

     <script src="https://app.arciumsignals.com/arcium-nav.js" data-current="datahub" defer></script>

   data-current  the id of this site in src/lib/apps.ts, shown as the current one
   data-app      where the Arcium app is (default: the address this script was loaded from)

   It draws a slim bar at the top of the page, inside a shadow root so the site's styles and the
   bar's never mix: the Arcium name (to the workspace), a Dashboards menu (every dashboard this
   account opens, the admin ones and the current schedule for an admin), and who is signed in or
   a Sign in link. It sets --arcium-bar (its height) on <html> for sites with their own sticky
   header. Everything from the server is put on the page as text, never as HTML. */
(function () {
  'use strict';
  if (window.__arciumNav) return;
  window.__arciumNav = true;
  var me = document.currentScript;
  var APP = (me && me.dataset.app) || (me && me.src ? new URL(me.src).origin : 'https://app.arciumsignals.com');
  var CURRENT = (me && me.dataset.current) || '';
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function short(iso) { return MONTHS[Number(iso.slice(5, 7)) - 1] + ' ' + Number(iso.slice(8, 10)); }

  var CSS = [
    ':host{all:initial;display:block;position:sticky;top:0;z-index:2147483000;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;',
    '--s:#ffffff;--i:#15181d;--m:#5d6573;--l:#dde1e7;--a:#0D9FD8}',
    '@media (prefers-color-scheme:dark){:host{--s:#14171c;--i:#e8eaee;--m:#9aa2b1;--l:#2a2f38;--a:#3fb8e8}}',
    '.bar{display:flex;align-items:center;gap:10px;height:40px;padding:0 12px;box-sizing:border-box;background:var(--s);color:var(--i);border-bottom:1px solid var(--l);font-size:13px}',
    '.brand{font-weight:800;letter-spacing:.02em;color:var(--i);text-decoration:none;white-space:nowrap}.brand b{color:var(--a)}',
    '.menu{position:relative}',
    'button{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:1px solid var(--l);border-radius:7px;background:var(--s);color:var(--i);font:inherit;font-weight:600;cursor:pointer}',
    'button:hover,button[aria-expanded="true"]{border-color:var(--a);color:var(--a)}button:focus-visible,a:focus-visible{outline:2px solid var(--a);outline-offset:2px}',
    '.caret{font-size:10px;color:var(--m)}',
    '.panel{position:absolute;left:0;top:34px;width:min(340px,calc(100vw - 24px));max-height:min(78vh,640px);overflow-y:auto;padding:8px;box-sizing:border-box;background:var(--s);border:1px solid var(--l);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.16)}',
    '.site{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--m);padding:4px 8px}',
    '.group+.group{border-top:1px solid var(--l);margin-top:6px;padding-top:6px}',
    '.app{display:block;margin:4px 0;padding:7px 10px;border:1px solid var(--l);border-radius:7px;text-decoration:none;color:var(--i);line-height:1.3}',
    '.app strong{display:block;font-size:13.5px;font-weight:600}.app span{display:block;font-size:12px;color:var(--m)}',
    '.app:hover,.app:focus-visible{background:color-mix(in srgb,var(--a) 10%,transparent);border-color:var(--a);outline:none}.app.on{border-color:var(--a)}.app.on strong{color:var(--a)}',
    '.sched{display:block;margin-bottom:6px;padding:8px;border-radius:8px;text-decoration:none;color:var(--i);line-height:1.35;background:color-mix(in srgb,var(--a) 8%,transparent);border:1px solid color-mix(in srgb,var(--a) 30%,transparent)}',
    '.sched .site{padding:0 0 3px}.sched strong{display:block;font-size:13.5px}.sched span{display:block;font-size:12px;color:var(--m)}.sched .late{color:#dc2626;font-weight:600}',
    '.who{margin-left:auto;color:var(--m);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.who a{color:var(--a);font-weight:600;text-decoration:none}',
    '@media (max-width:520px){.label{display:none}.panel{position:fixed;left:12px;right:12px;top:46px;width:auto}}',
  ].join('');

  function h(tag, attrs) {
    var el = document.createElement(tag);
    for (var k in attrs || {}) {
      if (attrs[k] == null) continue;
      if (k === 'text') el.textContent = attrs[k];
      else if (k === 'class') el.className = attrs[k];
      else el.setAttribute(k, attrs[k]);
    }
    for (var i = 2; i < arguments.length; i++) if (arguments[i]) el.appendChild(typeof arguments[i] === 'string' ? document.createTextNode(arguments[i]) : arguments[i]);
    return el;
  }
  function safeHref(u) { return /^https?:\/\//.test(u) ? u : APP; }

  var host = h('div', { id: 'arcium-nav' });
  var root = host.attachShadow({ mode: 'open' });
  // A constructed stylesheet passes a strict site CSP (style-src 'self'); older browsers get a <style>.
  try { var sheet = new CSSStyleSheet(); sheet.replaceSync(CSS); root.adoptedStyleSheets = [sheet]; }
  catch (e) { root.appendChild(h('style', { text: CSS })); }
  var btn = h('button', { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: 'Every Arcium dashboard' },
    h('span', { class: 'label', text: 'Dashboards' }), h('span', { class: 'caret', 'aria-hidden': 'true', text: '▾' }));
  var panel = h('div', { class: 'panel', role: 'menu', hidden: '' });
  var who = h('div', { class: 'who' });
  root.appendChild(h('nav', { class: 'bar', 'aria-label': 'Arcium' },
    h('a', { class: 'brand', href: APP + '/workspace' }, 'Arcium ', h('b', { text: 'Signals' })),
    h('div', { class: 'menu' }, btn, panel), who));

  function setOpen(open) { panel.hidden = !open; btn.setAttribute('aria-expanded', String(open)); }
  btn.addEventListener('click', function (e) { e.stopPropagation(); setOpen(panel.hidden); });
  document.addEventListener('click', function (e) { if (!host.contains(e.target)) setOpen(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });

  function render(d) {
    panel.replaceChildren();
    var s = d.schedule;
    if (d.admin && s) {
      var pct = Math.round((100 * s.done) / s.total);
      var a = h('a', { class: 'sched', role: 'menuitem', href: APP + '/control/schedule' },
        h('span', { class: 'site', text: s.name + ' · rev ' + s.version + ' · ' + pct + '%' }),
        h('strong', { text: s.phase ? 'Phase ' + s.phase.number + ': ' + s.phase.title : 'Every phase done' }));
      if (s.next && s.next[0]) a.appendChild(h('span', { text: 'Next: ' + s.next[0].text + ' (' + short(s.next[0].due) + (s.next[0].late ? ', late' : '') + ')' }));
      if (s.overdue) a.appendChild(h('span', { class: 'late', text: s.overdue + ' overdue' }));
      panel.appendChild(a);
    }
    (d.groups || []).forEach(function (g) {
      var box = h('div', { class: 'group' }, h('div', { class: 'site', text: g.site }));
      g.apps.forEach(function (x) {
        box.appendChild(h('a', { class: 'app' + (x.id === CURRENT ? ' on' : ''), role: 'menuitem', href: safeHref(x.href) },
          h('strong', { text: x.name }), h('span', { text: x.desc })));
      });
      panel.appendChild(box);
    });
    who.replaceChildren();
    if (d.signed_in) who.appendChild(document.createTextNode('Signed in as ' + d.username));
    else who.appendChild(h('a', { href: APP + '/?next=' + encodeURIComponent(location.href), text: 'Sign in' }));
  }

  function mount() {
    document.body.insertBefore(host, document.body.firstChild);
    // A site's own sticky header can sit under the bar: `top: var(--arcium-bar, 0px)`.
    document.documentElement.style.setProperty('--arcium-bar', '40px');
    fetch(APP + '/api/nav', { credentials: 'include' }).then(function (r) { return r.json(); }).then(render)
      .catch(function () { render({ groups: [], signed_in: false }); });
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
