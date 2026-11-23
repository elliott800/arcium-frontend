// Loads the Arcium bar from the Arcium app: the local one when this page runs locally.
// <script src="/static/nav-loader.js" data-current="<id in the app's src/lib/apps.ts>" defer>
// Locally (npm run sim) the pages are served by the same app on serviceshub.localhost / arcade.localhost, so the bar
// comes from localhost on the same port.
(function () {
  var me = document.currentScript;
  var local = /(^|\.)localhost$|^127\.0\.0\.1$/.test(location.hostname);
  var app = local ? location.protocol + '//localhost' + (location.port ? ':' + location.port : '') : 'https://app.arciumsignals.com';
  var s = document.createElement('script');
  s.src = app + '/arcium-nav.js';
  s.setAttribute('data-current', (me && me.dataset.current) || 'serviceshub');
  s.setAttribute('data-app', app);
  document.head.appendChild(s);
})();
