// functions/api/data.js  (Supabase step 1, Owen 2026-11-23)
// The dashboard's CHANGING data blocks, read from Supabase so the hourly refresh no longer redeploys the site.
//
//   GET /api/data            the newest index.json (which blocks exist + the build they came from), never cached
//   GET /api/data?path=P     one gzip block, e.g. 20261124T081512/pp-embedded.json.gz (immutable: the path names its build)
//
// Written by Scripts/page_data_push.py (PPSTATS-PC) into the PRIVATE Supabase Storage bucket "pricing-page". The page's boot
// hook (__ppRemote) swaps in blocks newer than the ones built into it; any failure here = the page shows its built-in data.
//
// Who may read: a signed-in viewer only. The Cloudflare Access token (Cf-Access-Jwt-Assertion, or the CF_Authorization cookie)
// is VERIFIED here - signature against the team's published keys, audience = this site's Access application, issuer, expiry,
// and a user e-mail - because the e-mail header alone can be forged on a URL Access does not front (per-deployment URLs).
// Fail-closed: anything missing or wrong = 401 / 403 / 503, never data.
//
// Settings (Cloudflare Pages > priceloadanalysis > Settings > Variables and Secrets, Production):
//   SUPABASE_URL          text    https://<project>.supabase.co
//   SUPABASE_SERVICE_KEY  SECRET  the project's service key (server-side only; never sent to the browser)
//   ACCESS_TEAM_DOMAIN    text    curly-firefly-f40b.cloudflareaccess.com
//   ACCESS_AUD            text    the Application Audience (AUD) tag of this site's Access application

const BUCKET = "pricing-page";
const PATH_RE = /^\d{8}T\d{6}\/pp-[a-z]+\.json\.gz$/;
const KEYS = { at: 0, team: "", keys: null };

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function b64urlBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function accessKeys(team) {
  if (KEYS.keys && KEYS.team === team && Date.now() - KEYS.at < 3600e3) return KEYS.keys;
  const r = await fetch("https://" + team + "/cdn-cgi/access/certs");
  if (!r.ok) throw new Error("certs " + r.status);
  const j = await r.json();
  KEYS.keys = (j && j.keys) || [];
  KEYS.team = team;
  KEYS.at = Date.now();
  return KEYS.keys;
}

// {email} for a valid Access user token for THIS application, else {status, error}.
export async function accessUser(request, env, now) {
  now = now || Date.now();
  const team = env.ACCESS_TEAM_DOMAIN, aud = env.ACCESS_AUD;
  if (!team || !aud) return { status: 503, error: "sign-in check not configured" };
  let tok = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!tok) {
    const m = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
    tok = m ? m[1] : "";
  }
  if (!tok) return { status: 401, error: "sign in" };
  const parts = tok.split(".");
  if (parts.length !== 3) return { status: 401, error: "bad token" };
  let head, body;
  try {
    head = JSON.parse(new TextDecoder().decode(b64urlBytes(parts[0])));
    body = JSON.parse(new TextDecoder().decode(b64urlBytes(parts[1])));
  } catch (e) {
    return { status: 401, error: "bad token" };
  }
  if (head.alg !== "RS256" || !head.kid) return { status: 401, error: "bad token" };
  let keys;
  try {
    keys = await accessKeys(team);
  } catch (e) {
    return { status: 503, error: "sign-in keys unavailable" };
  }
  let jwk = keys.find((k) => k.kid === head.kid);
  if (!jwk) {   // 11/24 review: Access rotated its signing keys: read them again once instead of refusing for up to an hour
    try {
      KEYS.at = 0;
      keys = await accessKeys(team);
      jwk = keys.find((k) => k.kid === head.kid);
    } catch (e) { /* refused below */ }
  }
  if (!jwk) return { status: 401, error: "unknown key" };
  let ok = false;
  try {
    const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]),
      new TextEncoder().encode(parts[0] + "." + parts[1]));
  } catch (e) {
    ok = false;
  }
  if (!ok) return { status: 401, error: "bad signature" };
  if (body.iss !== "https://" + team) return { status: 401, error: "wrong issuer" };
  const auds = Array.isArray(body.aud) ? body.aud : [body.aud];
  if (!auds.includes(aud)) return { status: 403, error: "not this application" };
  if (!(typeof body.exp === "number" && body.exp * 1000 > now)) return { status: 401, error: "expired" };
  if (typeof body.nbf === "number" && body.nbf * 1000 > now + 60e3) return { status: 401, error: "not yet valid" };
  if (!body.email) return { status: 403, error: "user sign-in required" };
  return { email: String(body.email).toLowerCase() };
}

export async function onRequestGet({ request, env }) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return json({ error: "not configured" }, 503);
  const who = await accessUser(request, env);
  if (!who.email) return json({ error: who.error }, who.status);

  const path = new URL(request.url).searchParams.get("path");
  const base = env.SUPABASE_URL.replace(/\/+$/, "") + "/storage/v1/object/" + BUCKET + "/";
  const auth = { apikey: env.SUPABASE_SERVICE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY };

  if (path === null) {
    // index.json is overwritten every hour and Supabase's CDN serves a cached copy despite no-cache: ask past the cache.
    const r = await fetch(base + "index.json?t=" + Date.now(), { headers: auth });
    if (!r.ok) return json({ error: "no data yet" }, r.status === 400 || r.status === 404 ? 404 : 502);
    return new Response(r.body, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }
  if (!PATH_RE.test(path)) return json({ error: "bad path" }, 400);

  // A block's path names its build, so its bytes never change: keep a copy at the edge when the Cache API is there.
  const cache = typeof caches !== "undefined" && caches.default ? caches.default : null;
  const ckey = new Request("https://pricing-page.cache/" + path);
  if (cache) {
    try {
      const hit = await cache.match(ckey);
      if (hit) return new Response(hit.body, { headers: blockHeaders() });
    } catch (e) { /* no cache here: read Supabase */ }
  }
  const r = await fetch(base + path, { headers: auth });
  if (!r.ok) return json({ error: "not found" }, r.status === 400 || r.status === 404 ? 404 : 502);
  const bytes = await r.arrayBuffer();
  if (cache) {
    try {
      await cache.put(ckey, new Response(bytes, { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "max-age=86400" } }));
    } catch (e) { /* fine */ }
  }
  return new Response(bytes, { headers: blockHeaders() });
}

function blockHeaders() {
  return { "Content-Type": "application/octet-stream", "Cache-Control": "private, max-age=86400, immutable" };
}
