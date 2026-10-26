/**
 * The client half of `relay.mjs`: joins a room on this page's own server and passes messages.
 *
 * Generic on purpose. It knows rooms, seats and who hosts, and nothing about any game; a game that
 * plays together builds its sync on top of it (Zombie Beat's is `src/game/NetSystem.js`). A page
 * served without the relay (a static host) fails to connect, and the game stays single-player.
 *
 * ```js
 * const net = new RelayClient();
 * net.onMessage = (from, m) => { ... };
 * await net.join('friday', 'Alex');
 * net.send('all', { t: 'hello' });
 * ```
 */
export class RelayClient {
  constructor() {
    this.socket = null;
    /** This client's id and seat once welcomed. */
    this.id = null;
    this.seat = null;
    this.host = null;
    /** `[{ id, seat, name }]`, everyone in the room including this client. */
    this.peers = [];
    this.room = null;
    /** `(from, message) => void` for what other players send. */
    this.onMessage = null;
    /** `(peers, host) => void` whenever the room changes. */
    this.onRoster = null;
    /** `(reason) => void` when the connection ends. */
    this.onClose = null;
  }

  get connected() {
    return this.socket?.readyState === WebSocket.OPEN && this.id !== null;
  }

  get isHost() {
    return this.connected && this.host === this.id;
  }

  /** Resolves once welcomed into the room; rejects if the relay cannot be reached or refuses. */
  join(room, name) {
    this.leave();
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${scheme}://${location.host}/relay?room=${encodeURIComponent(room)}&name=${encodeURIComponent(name)}`;
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      this.socket = socket;
      this.room = room;
      let welcomed = false;
      socket.addEventListener('message', (event) => {
        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }
        if (data.sys === 'welcome') {
          welcomed = true;
          this.id = data.id;
          this.seat = data.seat;
          this.applyRoster(data.peers, data.host);
          resolve(this);
        } else if (data.sys === 'roster') {
          this.applyRoster(data.peers, data.host);
        } else if (data.from && data.m) {
          try {
            this.onMessage?.(data.from, data.m);
          } catch (err) {
            console.error('[net] A message handler threw:', err);
          }
        }
      });
      socket.addEventListener('close', (event) => {
        const reason = event.reason || (welcomed ? 'disconnected' : 'could not reach the room relay');
        if (!welcomed) reject(new Error(reason));
        if (this.socket === socket) {
          this.socket = null;
          this.id = null;
          this.peers = [];
          this.onClose?.(reason);
        }
      });
    });
  }

  /** `to` is `'all'`, `'host'`, or a peer id. Dropped silently while not connected. */
  send(to, message) {
    if (this.connected) this.socket.send(JSON.stringify({ to, m: message }));
  }

  leave() {
    const socket = this.socket;
    this.socket = null;
    this.id = null;
    this.peers = [];
    socket?.close();
  }

  applyRoster(peers, host) {
    this.peers = Array.isArray(peers) ? peers : [];
    this.host = host;
    this.onRoster?.(this.peers, host);
  }
}
