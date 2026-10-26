import { WebSocketServer } from 'ws';

/**
 * A room relay for playing together, run inside this project's own Vite server.
 *
 * `npm run dev` (or `npm run dev:headset`, for a headset on your network) hosts it at `/relay`;
 * nothing else needs to be started, and `vite preview` hosts it too. A plain static host (GitHub
 * Pages, a CDN) has no relay, and the game then simply stays single-player.
 *
 * It is a relay and nothing more: it seats people in rooms, names one of them the host, and
 * forwards what they send. It runs no game and checks no claims, which is fine for friends playing
 * together and is not a design for strangers on the internet.
 *
 * | Client → relay | |
 * |---|---|
 * | `{ to: 'all' \| 'host' \| <peer id>, m: {...} }` | forward `m` |
 *
 * | Relay → client | |
 * |---|---|
 * | `{ sys: 'welcome', id, seat, host, peers }` | on joining: your id and seat, who hosts |
 * | `{ sys: 'roster', host, peers }` | whenever someone joins or leaves, or the host changes |
 * | `{ from: <peer id>, m: {...} }` | something another player sent |
 *
 * `peers` is `[{ id, seat, name }]`. Seats are small integers, the lowest free one on joining, so a
 * game can give each seat its own character. The host is whoever was first in; when they leave,
 * the lowest seat left takes over.
 */

const MAX_PEERS = 6;
const MAX_PAYLOAD = 16 * 1024;
/** Messages per second a peer may send before the extras are dropped. */
const MAX_RATE = 80;

export function relay() {
  return {
    name: 'game-relay',
    configureServer(server) {
      attach(server.httpServer);
    },
    configurePreviewServer(server) {
      attach(server.httpServer);
    },
  };
}

const cleanRoom = (value) => (typeof value === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(value) ? value.toLowerCase() : null);
const cleanName = (value) => (typeof value === 'string' ? value.replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 20) : '') || 'Player';

function attach(httpServer) {
  if (!httpServer) return;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  /** room → Map<id, peer> */
  const rooms = new Map();
  let nextId = 1;

  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://relay');
    // Everything else on this server (Vite's own hot-reload socket above all) is left alone.
    if (url.pathname !== '/relay') return;
    const room = cleanRoom(url.searchParams.get('room'));
    if (!room) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => join(ws, room, cleanName(url.searchParams.get('name'))));
  });

  function join(ws, roomName, name) {
    const room = rooms.get(roomName) ?? new Map();
    if (room.size >= MAX_PEERS) {
      ws.close(4001, 'room is full');
      return;
    }
    rooms.set(roomName, room);
    const taken = new Set([...room.values()].map((p) => p.seat));
    let seat = 0;
    while (taken.has(seat)) seat += 1;
    const peer = { id: `p${nextId++}`, seat, name, ws, host: room.size === 0, sent: 0, windowAt: Date.now() };
    room.set(peer.id, peer);

    send(peer, { sys: 'welcome', id: peer.id, seat, host: hostOf(room)?.id ?? peer.id, peers: list(room) });
    broadcastRoster(room);

    ws.on('message', (data) => {
      const now = Date.now();
      if (now - peer.windowAt >= 1000) {
        peer.windowAt = now;
        peer.sent = 0;
      }
      if (++peer.sent > MAX_RATE) return;
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!message || typeof message !== 'object' || !message.m || typeof message.m !== 'object') return;
      const out = JSON.stringify({ from: peer.id, m: message.m });
      for (const other of room.values()) {
        if (other === peer) continue;
        if (message.to === 'all' || (message.to === 'host' && other.host) || message.to === other.id) {
          if (other.ws.readyState === other.ws.OPEN) other.ws.send(out);
        }
      }
    });

    ws.on('close', () => {
      room.delete(peer.id);
      if (room.size === 0) {
        rooms.delete(roomName);
        return;
      }
      if (peer.host) {
        const next = [...room.values()].sort((a, b) => a.seat - b.seat)[0];
        next.host = true;
      }
      broadcastRoster(room);
    });
  }

  function hostOf(room) {
    return [...room.values()].find((p) => p.host) ?? null;
  }

  function list(room) {
    return [...room.values()].sort((a, b) => a.seat - b.seat).map((p) => ({ id: p.id, seat: p.seat, name: p.name }));
  }

  function broadcastRoster(room) {
    const message = { sys: 'roster', host: hostOf(room)?.id ?? null, peers: list(room) };
    for (const peer of room.values()) send(peer, message);
  }

  function send(peer, message) {
    if (peer.ws.readyState === peer.ws.OPEN) peer.ws.send(JSON.stringify(message));
  }
}
