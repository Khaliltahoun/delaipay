'use strict';
/**
 * Client HTTP de test : application COMPLÈTE (src/app.js, répartition par hôte) + navigateurs simulés.
 * http.request (et non fetch) : fetch ignore l'en-tête Host, indispensable pour simuler admin.localhost / <slug>.localhost.
 */
const http = require('http');

let srv = null, port = null;
function start() {
  if (srv) return port;
  const { createApp } = require('../../src/app');
  srv = createApp().listen(0); srv.unref(); port = srv.address().port;
  return port;
}
function stop() { try { srv && srv.close(); } catch (_) {} srv = null; }

function request(method, path, { host = 'localhost', cookies = {}, headers = {}, body, raw } = {}) {
  start();
  const payload = body !== undefined ? JSON.stringify(body) : null;
  const h = { Host: host, ...headers };
  const ck = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  if (ck) h.Cookie = ck;
  if (payload) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(payload); }
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: '127.0.0.1', port, path, method, headers: h }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('data', c => { data += c; });
      res.on('end', () => {
        let json = null; if (!raw) { try { json = JSON.parse(data); } catch (_) {} }
        const set = {};
        for (const c of [].concat(res.headers['set-cookie'] || [])) {
          const [kv, ...attrs] = c.split(';'); const i = kv.indexOf('=');
          set[kv.slice(0, i).trim()] = { value: decodeURIComponent(kv.slice(i + 1)), attrs: attrs.map(a => a.trim().toLowerCase()) };
        }
        resolve({ status: res.statusCode, body: json, text: data, headers: res.headers, setCookies: set });
      });
    });
    r.on('error', reject); if (payload) r.write(payload); r.end();
  });
}

/** Navigateur simulé : un hôte, un pot à cookies, en-têtes persistants (User-Agent…). */
function browser(host, { headers = {} } = {}) {
  const jar = {};
  const b = {
    host, jar, headers,
    async req(method, path, body, extra = {}) {
      const r = await request(method, path, { host: extra.host || host, cookies: { ...jar, ...(extra.cookies || {}) }, headers: { ...headers, ...(extra.headers || {}) }, body });
      for (const [k, v] of Object.entries(r.setCookies)) {
        if (v.value === '' || v.attrs.some(a => a.startsWith('expires=thu, 01 jan 1970'))) delete jar[k]; else jar[k] = v.value;
      }
      return r;
    },
    get(p, extra) { return b.req('GET', p, undefined, extra); },
    post(p, body = {}, extra) { return b.req('POST', p, body, extra); },
    put(p, body = {}, extra) { return b.req('PUT', p, body, extra); },
    patch(p, body = {}, extra) { return b.req('PATCH', p, body, extra); },
    del(p, body, extra) { return b.req('DELETE', p, body, extra); },
  };
  return b;
}

module.exports = { start, stop, request, browser };
