// The one door to the other PC (build rule 10): host a code, join a code, send, receive, status, close.
// Underneath is PeerJS (lib/peerjs.min.js, loaded the first time online play is used): its free public
// service introduces the two PCs, then they talk directly. No game logic lives here.
//
// What this file looks after on its own:
// - keepalive: a 'ping' every keepaliveMs; nothing heard for timeoutMs means the connection is lost
// - the host lets one friend in; a third player is told the game is full; a different version is refused
// - a new code that is already taken is swapped for another; a resumed code that the service still holds is
//   tried again until it is free
// - the friend keeps trying to reach the host again after any loss, until the host says bye
// - both sides get back in touch with the PeerJS service after losing it
import { PROTOCOL, make, validate, makeCode, peerIdFor } from './protocol.js';

/**
 * Loads PeerJS (a classic script that sets window.Peer) from lib, once.
 * @returns {Promise<any>}
 */
let peerLoad = null;
export function loadPeerJs() {
  if (window.Peer) return Promise.resolve(window.Peer);
  if (!peerLoad) {
    peerLoad = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = new URL('../lib/peerjs.min.js', import.meta.url).href;
      s.onload = () => (window.Peer ? resolve(window.Peer) : reject(new Error('PeerJS did not start')));
      s.onerror = () => { peerLoad = null; reject(new Error('lib/peerjs.min.js could not be loaded')); };
      document.head.appendChild(s);
    });
  }
  return peerLoad;
}

/**
 * @typedef {Object} NetStatus
 * @property {'none'|'host'|'guest'} role
 * @property {string} code          the join code (upper case), '' until known
 * @property {'idle'|'opening'|'open'|'failed'|'closed'} phase
 *           opening: getting the code (host) or finding the game (friend); open: the code is ours (host) or we were let in once (friend)
 * @property {boolean} link         the other player is connected right now
 * @property {boolean} server       in touch with the PeerJS service
 * @property {boolean} everLinked   the other player was connected at least once
 * @property {string} reason        failed: 'unreachable' | 'notFound' | 'full' | 'version' | 'cannotConnect' | 'taken' | 'noPeerJs'
 *                                  link down: 'friendLost' | 'friendLeft' | 'hostLost' | 'hostLeft'; host resuming: 'codeBusy'
 * @property {string} otherVersion  the other side's version (after hello/welcome/refuse)
 * @property {number} busyMs        host: how long the code has been found still held (0 when not)
 * @property {number} lastBusyMs    host: how long the code was held the last time it came free (for the report)
 */

/**
 * @param {Object} o
 * @param {string} o.version                  this game's version (the play-test number)
 * @param {Object} o.timing                   data/net.json
 * @param {(msg:Object) => void} o.onMessage  a checked game message from the other side
 * @param {(s:NetStatus) => void} o.onStatus  called on every status change
 */
export function createNet(o) {
  const T = o.timing;
  /** @type {NetStatus} */
  const st = { role: 'none', code: '', phase: 'idle', link: false, server: false, everLinked: false, reason: '', otherVersion: '', busyMs: 0, lastBusyMs: 0 };
  const guestId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  let peer = null;           // the PeerJS object
  let conn = null;           // the live connection to the other player
  let attempt = null;        // friend: a connection being tried
  let friendId = '';         // host: the guestId of the friend now in
  let lastHeard = 0;
  let closing = false;
  let wantCode = '';         // host: the code to (re)open; '' picks a new one
  let busySince = 0;
  let joinFails = 0;
  let retryTimer = 0;
  let deafConn = null;       // test only: a connection that silently stops working
  const timers = new Set();
  const now = () => Date.now();

  function later(ms, fn) { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; }
  function emit() { o.onStatus({ ...st }); }
  /** @param {Partial<NetStatus>} p */
  function set(p) { Object.assign(st, p); emit(); }
  function fail(reason, extra) {
    set({ phase: 'failed', reason, link: false, ...(extra || {}) });
    shutDown();
  }
  function shutDown() {
    for (const t of timers) clearTimeout(t);
    timers.clear(); retryTimer = 0;
    const p = peer; peer = null; conn = null; attempt = null;
    if (p) try { p.destroy(); } catch (e) { /* already gone */ }
  }
  const keep = setInterval(beat, T.keepaliveMs);

  /** Keepalive: say we are here, and notice when the other side has gone quiet. */
  function beat() {
    if (!conn || !st.link || closing) return;
    if (now() - lastHeard > T.timeoutMs) { linkLost(); return; }
    rawSend(make.ping());
  }
  function rawSend(msg) {
    if (!conn || conn === deafConn) return false;
    try { conn.send(msg); return true; } catch (e) { return false; }
  }
  /** The connection to the other player is gone (timeout, or it closed). */
  function linkLost() {
    const c = conn; conn = null;
    if (c) try { c.close(); } catch (e) { /* fine */ }
    if (st.role === 'host') set({ link: false, reason: st.reason === 'friendLeft' ? 'friendLeft' : 'friendLost' });
    else { set({ link: false, reason: 'hostLost' }); retryConnect(); }
  }
  function peerOpts() { return { debug: 0 }; }

  // ------------------------------------------------------------------ host

  async function host(code) {
    reset('host');
    wantCode = code || '';
    let Peer;
    try { Peer = await loadPeerJs(); } catch (e) { fail('noPeerJs'); return; }
    if (closing) return;
    openHost(Peer, 0);
  }
  function openHost(Peer, tries) {
    const code = wantCode || makeCode();
    let p;
    try { p = new Peer(peerIdFor(code), peerOpts()); } catch (e) { fail('unreachable'); return; }
    peer = p;
    set({ phase: st.phase === 'open' ? 'open' : 'opening', code: wantCode ? code : st.code });
    p.on('open', () => {
      if (p !== peer) return;
      if (busySince) { st.lastBusyMs = now() - busySince; busySince = 0; }
      wantCode = code;
      set({ phase: 'open', code, server: true, busyMs: 0, reason: st.reason === 'codeBusy' ? '' : st.reason });
    });
    p.on('connection', c => { if (p === peer && !closing) incoming(c); });
    p.on('disconnected', () => {
      if (p !== peer || closing) return;
      set({ server: false });
      later(T.serverRetryMs, () => { if (p === peer && !p.destroyed && p.disconnected) try { p.reconnect(); } catch (e) { /* the error handler tries again */ } });
    });
    p.on('error', err => {
      if (p !== peer || closing) return;
      const type = err && err.type;
      if (type === 'unavailable-id') {
        try { p.destroy(); } catch (e) { /* fine */ }
        if (!wantCode) {
          // a brand-new random code that someone already uses: pick another
          if (tries + 1 < T.newCodeTries) openHost(Peer, tries + 1); else fail('taken');
          return;
        }
        // our own code (resuming, or coming back after losing the service) is still held: wait and try again
        if (!busySince) busySince = now();
        set({ reason: st.link ? st.reason : 'codeBusy', busyMs: now() - busySince, server: false });
        if (now() - busySince > T.codeBusyGiveUpMs) { fail('taken'); return; }
        later(T.codeBusyRetryMs, () => { if (!closing && peer === p) openHost(Peer, tries); });
        return;
      }
      if (st.phase === 'opening' && !wantCode) { fail('unreachable'); return; }
      // trouble with the service after we had the code (or while resuming): keep trying in the background
      set({ server: false });
      later(T.serverRetryMs, () => {
        if (closing || peer !== p) return;
        if (p.destroyed) openHost(Peer, tries);
        else if (p.disconnected) try { p.reconnect(); } catch (e) { openHost(Peer, tries); }
      });
    });
  }
  /** Host: a new connection. It must say hello; then it is let in, or told why not. */
  function incoming(c) {
    let accepted = false;
    const t = later(T.helloTimeoutMs, () => { if (!accepted) try { c.close(); } catch (e) { /* fine */ } });
    const refuse = reason => { try { c.send(make.refuse(reason, o.version)); } catch (e) { /* fine */ } later(600, () => { try { c.close(); } catch (e) { /* fine */ } }); };
    c.on('data', d => {
      if (closing || !validate(d)) return;
      if (!accepted) {
        if (d.type !== 'hello') return;
        clearTimeout(t); timers.delete(t);
        if (d.version !== o.version || d.protocol !== PROTOCOL) { refuse('version'); return; }
        const sameFriend = d.guestId === friendId;
        if (conn && conn !== c && !sameFriend && st.link && now() - lastHeard < T.friendAliveMs) { refuse('full'); return; }
        if (conn && conn !== c) { const old = conn; conn = null; try { old.close(); } catch (e) { /* fine */ } }
        accepted = true; conn = c; friendId = d.guestId; lastHeard = now();
        try { c.send(make.welcome(o.version)); } catch (e) { /* the close handler sees it */ }
        set({ link: true, everLinked: true, reason: '', otherVersion: d.version });
        return;
      }
      if (c !== conn || c === deafConn) return;
      lastHeard = now();
      if (d.type === 'ping') return;
      if (d.type === 'bye') { conn = null; try { c.close(); } catch (e) { /* fine */ } set({ link: false, reason: 'friendLeft' }); return; }
      o.onMessage(d);
    });
    c.on('close', () => { if (c === conn && !closing) { conn = null; set({ link: false, reason: st.reason === 'friendLeft' ? 'friendLeft' : 'friendLost' }); } });
    c.on('error', () => { /* the close handler or the keepalive sees it */ });
  }

  // ------------------------------------------------------------------ friend

  async function join(code) {
    reset('guest');
    st.code = code;
    let Peer;
    try { Peer = await loadPeerJs(); } catch (e) { fail('noPeerJs'); return; }
    if (closing) return;
    startGuestPeer(Peer);
  }
  function startGuestPeer(Peer) {
    let p;
    try { p = new Peer(peerOpts()); } catch (e) { fail('unreachable'); return; }
    peer = p;
    if (st.phase !== 'open') set({ phase: 'opening' });
    p.on('open', () => { if (p !== peer || closing) return; set({ server: true }); if (!conn) connectToHost(); });
    p.on('disconnected', () => {
      if (p !== peer || closing) return;
      set({ server: false });
      later(T.serverRetryMs, () => { if (p === peer && !p.destroyed && p.disconnected) try { p.reconnect(); } catch (e) { /* the error handler tries again */ } });
    });
    p.on('error', err => {
      if (p !== peer || closing) return;
      const type = err && err.type;
      if (type === 'peer-unavailable') {
        // the service does not know the host's code (right now)
        attempt = null;
        if (!st.everLinked) fail('notFound'); else retryConnect();
        return;
      }
      if (!st.everLinked && st.phase === 'opening' && !st.server) { fail('unreachable'); return; }
      if (type === 'negotiation-failed' || type === 'webrtc') { attempt = null; noteJoinFail(); return; }
      set({ server: false });
      later(T.serverRetryMs, () => {
        if (closing || peer !== p) return;
        if (p.destroyed) startGuestPeer(Peer);
        else if (p.disconnected) try { p.reconnect(); } catch (e) { startGuestPeer(Peer); }
        else if (!conn) connectToHost();
      });
    });
  }
  /** Friend: one try to reach the host and be let in. */
  function connectToHost() {
    if (closing || !peer || conn || attempt || st.phase === 'failed' || st.reason === 'hostLeft') return;
    let c;
    try { c = peer.connect(peerIdFor(st.code), { reliable: true, serialization: 'json' }); } catch (e) { noteJoinFail(); return; }
    if (!c) { noteJoinFail(); return; }
    attempt = c;
    let welcomed = false;
    later(T.connectTimeoutMs, () => {
      if (attempt !== c || welcomed) return;
      attempt = null; try { c.close(); } catch (e) { /* fine */ }
      noteJoinFail();
    });
    c.on('open', () => { if (attempt === c) try { c.send(make.hello(o.version, guestId)); } catch (e) { /* the timeout tries again */ } });
    c.on('data', d => {
      if (closing || !validate(d)) return;
      if (!welcomed) {
        if (attempt !== c) return;
        if (d.type === 'refuse') { attempt = null; fail(d.reason === 'version' ? 'version' : 'full', { otherVersion: d.version }); return; }
        if (d.type !== 'welcome') return;
        if (d.version !== o.version || d.protocol !== PROTOCOL) { attempt = null; fail('version', { otherVersion: d.version }); return; }
        welcomed = true; attempt = null; conn = c; lastHeard = now(); joinFails = 0;
        set({ phase: 'open', link: true, everLinked: true, reason: '', otherVersion: d.version });
        return;
      }
      if (c !== conn || c === deafConn) return;
      lastHeard = now();
      if (d.type === 'ping') return;
      if (d.type === 'bye') { conn = null; try { c.close(); } catch (e) { /* fine */ } set({ link: false, reason: 'hostLeft' }); return; }
      o.onMessage(d);
    });
    c.on('close', () => {
      if (closing) return;
      if (c === conn) { conn = null; set({ link: false, reason: st.reason === 'hostLeft' ? 'hostLeft' : 'hostLost' }); retryConnect(); }
      else if (c === attempt) { attempt = null; noteJoinFail(); }
    });
    c.on('error', () => { /* the close handler or the timeout sees it */ });
  }
  function noteJoinFail() {
    if (!st.everLinked && ++joinFails >= T.joinTries) { fail('cannotConnect'); return; }
    retryConnect();
  }
  function retryConnect() {
    if (closing || st.role !== 'guest' || st.phase === 'failed' || st.reason === 'hostLeft' || retryTimer) return;
    retryTimer = later(T.reconnectDelayMs, () => {
      retryTimer = 0;
      if (closing || conn) return;
      if (!peer || peer.destroyed) { loadPeerJs().then(P => { if (!closing && !conn) startGuestPeer(P); }); return; }
      if (peer.disconnected) { try { peer.reconnect(); } catch (e) { /* tried again below */ } retryConnect(); return; }
      attempt = null;
      connectToHost();
    });
  }

  // ------------------------------------------------------------------ both

  function reset(role) {
    closing = false; shutDown();
    friendId = ''; busySince = 0; joinFails = 0; deafConn = null;
    Object.assign(st, { role, code: '', phase: 'opening', link: false, server: false, everLinked: false, reason: '', otherVersion: '', busyMs: 0 });
    emit();
  }

  return {
    /** Host a game. With a code: open that code again (resuming a saved match), waiting while the service still holds it. @param {string} [code] */
    host,
    /** Join the game with this code. @param {string} code */
    join,
    /** Send a message to the other player. False when not connected. @param {Object} msg */
    send(msg) { return st.link ? rawSend(msg) : false; },
    /** @returns {NetStatus} */
    status: () => ({ ...st }),
    /**
     * Leave on purpose: tell the other side, then let go of everything.
     * @param {boolean} [quiet] true: no 'bye' (the page is closing; the host's match is kept to resume)
     */
    close(quiet) {
      if (st.role === 'none') return;
      if (!quiet && conn) rawSend(make.bye());
      closing = true;
      const p = peer; peer = null; conn = null; attempt = null;
      for (const t of timers) clearTimeout(t);
      timers.clear(); retryTimer = 0;
      if (p) setTimeout(() => { try { p.destroy(); } catch (e) { /* fine */ } }, quiet ? 0 : 300);
      Object.assign(st, { role: 'none', phase: 'closed', link: false, server: false, reason: '' });
      emit();
    },
    /** Stop for good (the page is going away). */
    dispose() { clearInterval(keep); },
    // test only
    debug: {
      /** The connection breaks now, as if the cable was pulled on this side (the other side sees it close). */
      drop() { if (conn) linkLost(); },
      /** The connection stops carrying anything in either direction, without closing: only the keepalive notices. */
      deafen() { deafConn = conn; },
      guestId: () => guestId,
    },
  };
}
