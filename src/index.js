import { DurableObject } from "cloudflare:workers";

// Worker: static UI comes from ./public (assets); everything else is routed
// to a single ToastRoom Durable Object, which serialises on/off events,
// writes them to D1 and fans out updates over hibernatable WebSockets.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const room = env.ROOM.get(env.ROOM.idFromName("kitchen"));

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket")
        return new Response("Expected WebSocket", { status: 426 });
      return room.fetch(request);
    }

    if (url.pathname === "/hook/on" || url.pathname === "/hook/off") {
      // Fail closed: if the TOKEN secret isn't set, refuse all hook calls.
      if (!env.TOKEN) return new Response("TOKEN secret not configured", { status: 503 });
      if (url.searchParams.get("token") !== env.TOKEN)
        return new Response("bad token", { status: 401 });
      return room.fetch(request);
    }

    if (url.pathname === "/api/toasts") {
      return Response.json(await snapshot(env));
    }

    return new Response("Not found", { status: 404 });
  },
};

// Compact snapshot: done toasts as [startedAt, seconds], plus any in-progress start.
async function snapshot(env) {
  const { results } = await env.DB.prepare(
    "SELECT started_at, ended_at, seconds FROM toasts ORDER BY started_at"
  ).all();
  const toasts = [];
  let current = null;
  for (const r of results) {
    if (r.ended_at == null) current = r.started_at;
    else toasts.push([r.started_at, r.seconds]);
  }
  return { type: "snapshot", toasts, current };
}

// If an "off" never arrives (e.g. power cut), don't leave a toast open forever.
const STALE_MS = 20 * 60 * 1000;

export class ToastRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Answered by the runtime without waking the object from hibernation.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request) {
    const { pathname } = new URL(request.url);

    if (pathname === "/ws") {
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server); // hibernatable
      server.send(JSON.stringify(await snapshot(this.env)));
      return new Response(null, { status: 101, webSocket: client });
    }

    const changed = pathname === "/hook/on" ? await this.on() : await this.off();
    if (changed) await this.broadcast();
    return new Response(changed ? "ok" : "ok (no change)");
  }

  async openToast() {
    return this.env.DB.prepare(
      "SELECT id, started_at FROM toasts WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1"
    ).first();
  }

  async on() {
    const now = Date.now();
    const open = await this.openToast();
    if (open && now - open.started_at < STALE_MS) return false; // already toasting
    if (open) await this.env.DB.prepare("DELETE FROM toasts WHERE id = ?").bind(open.id).run();
    await this.env.DB.prepare("INSERT INTO toasts (started_at) VALUES (?)").bind(now).run();
    return true;
  }

  async off() {
    const open = await this.openToast();
    if (!open) return false;
    const now = Date.now();
    const seconds = Math.round((now - open.started_at) / 1000);
    if (seconds < Number(this.env.MIN_SECONDS || 20)) {
      // Too short to be real toast (a blip, or someone testing the lever)
      await this.env.DB.prepare("DELETE FROM toasts WHERE id = ?").bind(open.id).run();
    } else {
      await this.env.DB.prepare("UPDATE toasts SET ended_at = ?, seconds = ? WHERE id = ?")
        .bind(now, seconds, open.id).run();
    }
    return true;
  }

  async broadcast() {
    const msg = JSON.stringify(await snapshot(this.env));
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch {}
    }
  }

  async webSocketMessage(ws, message) {
    // Clients don't need to send anything besides "ping" (auto-responded).
  }

  async webSocketClose(ws, code) {
    try { ws.close(code, "bye"); } catch {}
  }
}
