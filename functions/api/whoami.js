// functions/api/whoami.js
// Returns the signed-in user's identity, taken straight from Cloudflare Access
// (fronted by Entra SSO). The dashboard calls this on load so the presence layer can
// label "you" correctly and pick a stable avatar colour — and so it only attempts a
// socket on the real site, never on a local file:// preview.
//
// Safe by construction: it only ever echoes back the CALLER'S OWN identity — the same
// email Access already authenticated them with. No lookup, no one else's details.

export async function onRequestGet(context) {
  const { request } = context;
  const email = request.headers.get("Cf-Access-Authenticated-User-Email") || "";

  let name = "";
  if (email) {
    name = email
      .split("@")[0]
      .replace(/[._-]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  return new Response(JSON.stringify({ email, name }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
