// functions/api/room.js
// Same-origin WebSocket entry point for the Pricing Dashboard's presence layer.
//
// Because this lives on the Pages domain it is ALREADY behind Cloudflare Access
// (Entra SSO), so only authenticated @peterpanbus.com staff can open the socket and
// we get the caller's real identity for free from the Access header. The browser
// never talks to the realtime Worker directly; this forwards the upgrade to the
// PricingRoom Durable Object via the ROOM binding.
//
// Until the ROOM binding is wired up in the Pages project this returns 503 and the
// dashboard runs exactly as it does today — no presence, nothing broken.

export async function onRequest(context) {
  const { request, env } = context;

  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("expected a websocket upgrade", { status: 426 });
  }
  if (!env.ROOM) {
    return new Response("presence not configured (ROOM binding missing)", { status: 503 });
  }

  // Server-authoritative identity: taken from Access, never from the client.
  const email = request.headers.get("Cf-Access-Authenticated-User-Email") || "";
  const url = new URL(request.url);
  if (email) url.searchParams.set("email", email);

  // One shared room for the whole dashboard.
  const id = env.ROOM.idFromName("pricing-dashboard");
  return env.ROOM.get(id).fetch(url.toString(), request);
}
