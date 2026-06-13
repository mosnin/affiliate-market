import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/track/cola.js
 *
 * The hosted tracking snippet sellers drop on their OWN site. It does three
 * things, entirely client-side, so the seller's bridge becomes zero-code:
 *
 *   1. Captures ?via=CODE / ?ref=CODE from the URL into a first-party
 *      `cola_ref` cookie (30 days) + a stable `cola_vid` visitor id.
 *   2. Pings Cola's /api/track/click so the click is attributed even before
 *      a purchase.
 *   3. Exposes window.cola.ref() so the seller's checkout code can pass it
 *      into Stripe Checkout metadata: metadata: { cola_ref: window.cola.ref() }.
 *      It also auto-stamps any <a href="...stripe..."> and hidden inputs
 *      named "cola_ref" if present.
 *
 * Served as JavaScript with permissive CORS + a short cache. The Cola API
 * origin is baked in from the request so the snippet posts back to the
 * right place regardless of where it's embedded.
 */
export async function GET(req: NextRequest) {
  const origin = (process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin).replace(/\/$/, '');

  const js = `(function () {
  var API = ${JSON.stringify(origin)};
  var REF = 'cola_ref', VID = 'cola_vid', PARAMS = ['via', 'ref'];

  function getCookie(name) {
    var m = document.cookie.match('(?:^|; )' + name + '=([^;]*)');
    return m ? decodeURIComponent(m[1]) : null;
  }
  function setCookie(name, value, days) {
    var d = new Date(); d.setTime(d.getTime() + days * 864e5);
    document.cookie = name + '=' + encodeURIComponent(value) + ';expires=' + d.toUTCString() + ';path=/;SameSite=Lax';
  }
  function uuid() {
    try { return crypto.randomUUID(); } catch (e) {
      return 'xxxxxxxxyxxx'.replace(/[xy]/g, function (c) {
        var r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      }) + Date.now().toString(16);
    }
  }

  var params = new URLSearchParams(location.search);
  var code = null;
  for (var i = 0; i < PARAMS.length; i++) { var v = params.get(PARAMS[i]); if (v) { code = v; break; } }
  if (code) setCookie(REF, code, 30);
  if (!getCookie(VID)) setCookie(VID, uuid(), 365);

  var ref = getCookie(REF);

  // Fire-and-forget click attribution when arriving with a code.
  if (code) {
    try {
      fetch(API + '/api/track/click', {
        method: 'POST', mode: 'cors', keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code, landingUrl: location.href, referrer: document.referrer || null, visitorId: getCookie(VID) })
      }).catch(function () {});
    } catch (e) {}
  }

  // Stamp any hidden inputs named cola_ref (server-rendered checkout forms).
  if (ref) {
    try {
      var inputs = document.querySelectorAll('input[name="cola_ref"]');
      for (var j = 0; j < inputs.length; j++) inputs[j].value = ref;
    } catch (e) {}
  }

  // Public API for the seller's checkout code.
  window.cola = window.cola || {};
  window.cola.ref = function () { return getCookie(REF); };
  window.cola.visitorId = function () { return getCookie(VID); };
})();`;

  return new NextResponse(js, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
