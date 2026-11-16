#!/usr/bin/env node
'use strict';
/*
 * Freeze the running server's current data into one self-contained page that
 * can be published as a static snapshot (no server, no live updates).
 *
 *   node flow/server.js &                       # wait for the first refresh
 *   node flow/build-artifact.js > snapshot.html # optional: --from http://localhost:4173
 */
const fs = require('fs');
const path = require('path');
const i = process.argv.indexOf('--from');
const from = i > 0 ? process.argv[i + 1] : 'http://localhost:4173';
const must = (s, a, b) => { if (!s.includes(a)) throw new Error('build-artifact: page changed, missing: ' + a.slice(0, 50)); return s.replace(a, b); };

(async () => {
  const r = await fetch(from + '/api/flow');
  if (!r.ok) throw new Error('server has no data yet (HTTP ' + r.status + ')');
  const d = await r.json();
  if (d.missing && d.missing.length) throw new Error('refusing to snapshot: no data for ' + d.missing.length + ' symbols (rate limited?). Retry later.');
  d.snapshot = true; d.live = false; d.errors = [];
  let h = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const style = h.slice(h.indexOf('<style>'), h.indexOf('</style>') + 8);
  let body = h.slice(h.indexOf('<body>') + 6, h.indexOf('</body>'));
  const CDN = 'https://cdn.jsdelivr.net/npm/three@0.147.0/';
  body = must(body, 'src="vendor/three.min.js"', `src="${CDN}build/three.min.js"`);
  body = must(body, 'src="vendor/OrbitControls.js"', `src="${CDN}examples/js/controls/OrbitControls.js"`);
  const a = body.indexOf("fetch('api/flow'"), b = body.indexOf('}).then(function (d) {', a);
  if (a < 0 || b < 0) throw new Error('build-artifact: fetch block not found');
  body = body.slice(0, a) + 'Promise.resolve(FLOW_SNAPSHOT).then(function (d) {' + body.slice(b + '}).then(function (d) {'.length);
  body = must(body, 'load(); setInterval(load, 15000);', 'load();');
  // Published pages keep text clear of phone system bars.
  const L = 'max(16px, env(safe-area-inset-left, 0px))', R = 'max(16px, env(safe-area-inset-right, 0px))';
  const T = 'calc(12px + env(safe-area-inset-top, 0px))', B = 'calc(12px + env(safe-area-inset-bottom, 0px))';
  let css = style;
  css = must(css, '#head { top: 12px; left: 12px;', `#head { top: ${T}; left: ${L};`);
  css = must(css, '#sectors { top: 12px; right: 12px;', `#sectors { top: ${T}; right: ${R};`);
  css = must(css, '#bar { left: 12px; right: 12px; bottom: 12px;', `#bar { left: ${L}; right: ${R}; bottom: ${B};`);
  css = must(css, 'bottom: 74px; right: 12px; left: 12px;', `bottom: calc(74px + env(safe-area-inset-bottom, 0px)); right: ${R}; left: ${L};`);
  process.stdout.write(
    '<title>Money Flow 3D</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n' + css +
    '\n<script>var FLOW_SNAPSHOT = ' + JSON.stringify(d).replace(/</g, '\\u003c') + ';</script>\n' + body);
})().catch((e) => { console.error(e.message); process.exit(1); });
