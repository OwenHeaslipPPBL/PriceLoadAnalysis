// functions/api/q.js  (Supabase step 2, Owen 2026-11-24: "filled by queries to the database")
// Named, READ-ONLY questions to the Supabase database (schema pricing) for a signed-in viewer only: the same Cloudflare
// Access token check as /api/data (signature, audience, issuer, expiry, user e-mail; fail closed). The service key stays
// here. Only the queries below exist: no SQL, table or column names come from the browser.
//
//   GET /api/q?legs=YYYY-MM-DD&to=YYYY-MM-DD   stop-by-stop dispatch detail of DEPARTED trips (pricing.trip_legs, written by
//                                              Scripts/legs_to_supabase.py), at most 31 days: {from, to, trips:{date:{sched:trip}},
//                                              read:{date: newest read time}}. Counts, stop names, times and seats only.
import { accessUser } from "./data.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 31, PAGE = 1000, MAX_ROWS = 20000;

function out(obj, status, cache) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": cache || "no-store" },
  });
}

// Every row of one read-only PostgREST query, a page at a time (Supabase returns at most 1,000 rows per request).
export async function dbRows(env, table, query) {
  const url = env.SUPABASE_URL.replace(/\/+$/, "") + "/rest/v1/" + table + "?" + query;
  const h = { apikey: env.SUPABASE_SERVICE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, "Accept-Profile": "pricing" };
  const all = [];
  for (let start = 0; start < MAX_ROWS; start += PAGE) {
    const r = await fetch(url, { headers: { ...h, Range: start + "-" + (start + PAGE - 1) } });
    if (!r.ok) throw new Error("db " + r.status);
    const part = await r.json();
    if (!Array.isArray(part)) throw new Error("db answer");
    all.push(...part);
    if (part.length < PAGE) return all;
  }
  return all;
}

function days(from, to) {
  const a = Date.parse(from + "T00:00:00Z"), b = Date.parse(to + "T00:00:00Z");
  if (isNaN(a) || isNaN(b) || new Date(a).toISOString().slice(0, 10) !== from || new Date(b).toISOString().slice(0, 10) !== to) return NaN;
  return (b - a) / 864e5 + 1;
}

export async function onRequestGet({ request, env }) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return out({ error: "not configured" }, 503);
  const who = await accessUser(request, env);
  if (!who.email) return out({ error: who.error }, who.status);
  const q = new URL(request.url).searchParams;

  if (q.has("legs")) {
    const from = q.get("legs") || "", to = q.get("to") || from;
    if (!DAY.test(from) || !DAY.test(to)) return out({ error: "bad dates" }, 400);
    const n = days(from, to);
    if (!(n >= 1 && n <= MAX_DAYS)) return out({ error: "1 to " + MAX_DAYS + " days, from before to" }, 400);
    let list;
    try {
      list = await dbRows(env, "trip_legs", "select=dep_date,schedule,trip,read_at&dep_date=gte." + from + "&dep_date=lte." + to + "&order=dep_date,schedule");
    } catch (e) {
      return out({ error: "database unavailable" }, 502);
    }
    const trips = {}, read = {};
    for (const x of list) {
      (trips[x.dep_date] = trips[x.dep_date] || {})[x.schedule] = x.trip;
      if (!read[x.dep_date] || String(x.read_at) > read[x.dep_date]) read[x.dep_date] = String(x.read_at);
    }
    return out({ from, to, trips, read }, 200, "private, max-age=300");
  }
  return out({ error: "unknown query" }, 400);
}
