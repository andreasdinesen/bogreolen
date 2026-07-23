'use strict';
/* Min Bogreol – selvstændig server til Yggdrasil Panel
 * Node.js (>=22) uden npm-afhængigheder: node:http + node:sqlite + node:crypto.
 * Funktioner: brugere, sessions, kodeord (scrypt), passkeys (WebAuthn),
 * admin-styring og bog-API. Alt data ligger i SQLite i serverens datamappe. */

const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const BIND_PORT = parseInt(process.env.BIND_PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || process.cwd();
const APP_DIR = __dirname;
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const APP_NAME = process.env.APP_NAME || 'Min Bogreol';
const SESSION_DAYS = 90;

/* ---------------- database ---------------- */
const db = new DatabaseSync(path.join(DATA_DIR, 'bogreol.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  pass_salt TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  jwk TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  label TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_books_user ON books(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

const q = {
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
  adminCount: db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1'),
  insertUser: db.prepare('INSERT INTO users (username, pass_salt, pass_hash, is_admin, created_at) VALUES (?,?,?,?,?)'),
  setPassword: db.prepare('UPDATE users SET pass_salt = ?, pass_hash = ? WHERE id = ?'),
  setAdmin: db.prepare('UPDATE users SET is_admin = ? WHERE id = ?'),
  deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
  allUsers: db.prepare(`SELECT u.id, u.username, u.is_admin, u.created_at,
      (SELECT COUNT(*) FROM books b WHERE b.user_id = u.id AND b.deleted = 0) AS books,
      (SELECT COUNT(*) FROM credentials c WHERE c.user_id = u.id) AS passkeys
    FROM users u ORDER BY u.id`),
  insertSession: db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)'),
  sessionByToken: db.prepare('SELECT * FROM sessions WHERE token = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
  credById: db.prepare('SELECT * FROM credentials WHERE id = ?'),
  credsByUser: db.prepare('SELECT id, label, created_at FROM credentials WHERE user_id = ? ORDER BY created_at'),
  insertCred: db.prepare('INSERT INTO credentials (id, user_id, jwk, counter, label, created_at) VALUES (?,?,?,?,?,?)'),
  updateCounter: db.prepare('UPDATE credentials SET counter = ? WHERE id = ?'),
  deleteCred: db.prepare('DELETE FROM credentials WHERE id = ? AND user_id = ?'),
  deleteUserCreds: db.prepare('DELETE FROM credentials WHERE user_id = ?'),
  booksByUser: db.prepare('SELECT data FROM books WHERE user_id = ? AND deleted = 0'),
  bookById: db.prepare('SELECT * FROM books WHERE id = ?'),
  upsertBook: db.prepare(`INSERT INTO books (id, user_id, data, updated_at, deleted) VALUES (?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, deleted = excluded.deleted
    WHERE books.user_id = excluded.user_id`),
  deleteUserBooks: db.prepare('DELETE FROM books WHERE user_id = ?'),
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
};

const nowIso = () => new Date().toISOString();
const setting = (key, dflt) => { const r = q.getSetting.get(key); return r ? r.value : dflt; };

/* ---------------- helpers ---------------- */
const b64u = buf => Buffer.from(buf).toString('base64url');
const fromB64u = s => Buffer.from(String(s || ''), 'base64url');
const sha256 = buf => crypto.createHash('sha256').update(buf).digest();

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
}
function verifyPassword(user, password) {
  const h = Buffer.from(hashPassword(password, user.pass_salt), 'hex');
  const stored = Buffer.from(user.pass_hash, 'hex');
  return h.length === stored.length && crypto.timingSafeEqual(h, stored);
}
function createSession(res, userId, secure) {
  const token = crypto.randomBytes(32).toString('hex');
  const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  q.insertSession.run(token, userId, nowIso(), exp);
  const cookie = [`bogreol_session=${token}`, 'HttpOnly', 'Path=/', 'SameSite=Lax',
    `Max-Age=${SESSION_DAYS * 86400}`].concat(secure ? ['Secure'] : []).join('; ');
  res.setHeader('Set-Cookie', cookie);
}
function readCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}
function currentUser(req) {
  const token = readCookies(req).bogreol_session;
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const s = q.sessionByToken.get(token);
  if (!s) return null;
  if (s.expires_at < nowIso()) { q.deleteSession.run(token); return null; }
  const u = q.userById.get(s.user_id);
  if (!u) { q.deleteSession.run(token); return null; }
  u._token = token;
  return u;
}
function reqContext(req) {
  const proto = (String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()) ||
    (req.socket.encrypted ? 'https' : 'http');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return { origin: proto + '://' + host, rpId: hostname, secure: proto === 'https' };
}

/* simple rate limit for login attempts */
const attempts = new Map();
function rateLimited(key) {
  const now = Date.now();
  const a = attempts.get(key) || [];
  const recent = a.filter(t => now - t < 15 * 60e3);
  attempts.set(key, recent);
  return recent.length >= 15;
}
function noteAttempt(key) { (attempts.get(key) || attempts.set(key, []).get(key)).push(Date.now()); }

/* ---------------- CBOR (minimal decoder) ---------------- */
function cborDecodeFirst(buf) {
  let off = 0;
  function readLen(ai) {
    if (ai < 24) return ai;
    if (ai === 24) return buf[off++];
    if (ai === 25) { const v = buf.readUInt16BE(off); off += 2; return v; }
    if (ai === 26) { const v = buf.readUInt32BE(off); off += 4; return v; }
    if (ai === 27) { const v = Number(buf.readBigUInt64BE(off)); off += 8; return v; }
    throw new Error('cbor: unsupported length');
  }
  function read() {
    if (off >= buf.length) throw new Error('cbor: truncated');
    const ib = buf[off++], mt = ib >> 5, ai = ib & 31;
    if (mt === 7) {
      if (ai === 20) return false;
      if (ai === 21) return true;
      if (ai === 22 || ai === 23) return null;
      throw new Error('cbor: unsupported simple/float');
    }
    const len = readLen(ai);
    switch (mt) {
      case 0: return len;
      case 1: return -1 - len;
      case 2: { const v = buf.subarray(off, off + len); off += len; return Buffer.from(v); }
      case 3: { const v = buf.subarray(off, off + len).toString('utf8'); off += len; return v; }
      case 4: { const a = []; for (let i = 0; i < len; i++) a.push(read()); return a; }
      case 5: { const m = new Map(); for (let i = 0; i < len; i++) { const k = read(); m.set(k, read()); } return m; }
      default: throw new Error('cbor: unsupported major type');
    }
  }
  const v = read();
  return [v, off];
}

/* ---------------- WebAuthn ---------------- */
function coseToJwk(cose) {
  const kty = cose.get(1), alg = cose.get(3);
  if (kty === 2) { // EC2
    if (cose.get(-1) !== 1 || alg !== -7) throw new Error('Ukendt EC-kurve/algoritme');
    return { kty: 'EC', crv: 'P-256', x: b64u(cose.get(-2)), y: b64u(cose.get(-3)) };
  }
  if (kty === 3) { // RSA
    if (alg !== -257) throw new Error('Ukendt RSA-algoritme');
    return { kty: 'RSA', n: b64u(cose.get(-1)), e: b64u(cose.get(-2)) };
  }
  throw new Error('Ukendt nøgletype');
}
function parseAuthData(authData) {
  if (authData.length < 37) throw new Error('authData for kort');
  const out = {
    rpIdHash: authData.subarray(0, 32),
    flags: authData[32],
    counter: authData.readUInt32BE(33)
  };
  if (out.flags & 0x40) { // attested credential data
    const credIdLen = authData.readUInt16BE(53);
    out.credId = authData.subarray(55, 55 + credIdLen);
    const [cose] = cborDecodeFirst(authData.subarray(55 + credIdLen));
    out.cose = cose;
  }
  return out;
}
function verifyClientData(cdJson, expectType, expectChallenge, expectOrigin) {
  let cd;
  try { cd = JSON.parse(cdJson.toString('utf8')); } catch (e) { throw new Error('Ugyldig clientData'); }
  if (cd.type !== expectType) throw new Error('Forkert clientData-type');
  if (cd.challenge !== expectChallenge) throw new Error('Challenge matcher ikke');
  if (cd.origin !== expectOrigin) throw new Error('Origin matcher ikke (' + cd.origin + ' ≠ ' + expectOrigin + ')');
  return cd;
}
function verifyAssertionSignature(jwkJson, authData, cdJson, sig) {
  const key = crypto.createPublicKey({ key: JSON.parse(jwkJson), format: 'jwk' });
  const signed = Buffer.concat([authData, sha256(cdJson)]);
  return crypto.verify('sha256', signed, key, sig);
}

/* challenge store (in-memory, kortlivet) */
const challenges = new Map();
function issueChallenge(data) {
  const id = crypto.randomBytes(16).toString('hex');
  challenges.set(id, Object.assign({ exp: Date.now() + 5 * 60e3 }, data));
  if (challenges.size > 1000) { // oprydning
    for (const [k, v] of challenges) if (v.exp < Date.now()) challenges.delete(k);
  }
  return id;
}
function takeChallenge(id) {
  const c = challenges.get(id);
  challenges.delete(id);
  if (!c || c.exp < Date.now()) return null;
  return c;
}

/* ---------------- HTTP plumbing ---------------- */
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}
const err = (res, code, message) => send(res, code, { error: message });

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > (maxBytes || 6e6)) { reject(new Error('For stor forespørgsel')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('Ugyldig JSON')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};
function serveStatic(res, relPath) {
  const full = path.normalize(path.join(PUBLIC_DIR, relPath));
  if (!full.startsWith(PUBLIC_DIR)) return err(res, 404, 'Ikke fundet');
  fs.readFile(full, (e, data) => {
    if (e) return err(res, 404, 'Ikke fundet');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': relPath.startsWith('libs/') ? 'public, max-age=604800' : 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  });
}

/* ---------------- validation ---------------- */
const USERNAME_RE = /^[a-zA-Z0-9._æøåÆØÅ-]{2,32}$/;
function validPassword(p) { return typeof p === 'string' && p.length >= 8 && p.length <= 200; }
function sanitizeBook(b) {
  if (!b || typeof b !== 'object' || typeof b.id !== 'string' || !/^[0-9a-f-]{8,64}$/i.test(b.id)) return null;
  const s = v => String(v == null ? '' : v).slice(0, 2000);
  return {
    id: b.id,
    isbn: s(b.isbn).slice(0, 32),
    title: s(b.title).slice(0, 500),
    authors: Array.isArray(b.authors) ? b.authors.slice(0, 10).map(a => s(a).slice(0, 200)) : [],
    cover: String(b.cover == null ? '' : b.cover).slice(0, 200000),
    series: s(b.series).slice(0, 300),
    seriesNo: s(b.seriesNo).slice(0, 10),
    edition: s(b.edition).slice(0, 100),
    printing: s(b.printing).slice(0, 100),
    loaned: !!(b.loaned || b.loanedTo),
    loanedTo: s(b.loanedTo).slice(0, 200),
    loanedAt: s(b.loanedAt).slice(0, 40) || null,
    owned: !!b.owned,
    format: ['hardback', 'paperback'].includes(b.format) ? b.format : 'paperback',
    read: !!b.read,
    readYear: Number.isInteger(b.readYear) ? b.readYear : null,
    wishlist: !!b.wishlist,
    rating: Number.isInteger(b.rating) && b.rating >= 0 && b.rating <= 5 ? b.rating : 0,
    notes: s(b.notes).slice(0, 5000),
    addedAt: s(b.addedAt).slice(0, 40) || nowIso(),
    updatedAt: s(b.updatedAt).slice(0, 40) || nowIso(),
    deleted: !!b.deleted
  };
}
function meJson(u) {
  return {
    id: u.id, username: u.username, isAdmin: !!u.is_admin,
    passkeys: q.credsByUser.all(u.id).map(c => ({ id: c.id, label: c.label || 'Passkey', created: c.created_at }))
  };
}

/* ---------------- router ---------------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const ctx = reqContext(req);

  try {
    /* --- static --- */
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(res, 'index.html');
    if (req.method === 'GET' && p === '/manifest.webmanifest') {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
      return res.end(JSON.stringify({
        name: APP_NAME, short_name: 'Bogreol', start_url: '.', display: 'standalone',
        background_color: '#f9f9f7', theme_color: '#2a78d6', lang: 'da',
        icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
                { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }]
      }));
    }
    if (req.method === 'GET' && /^\/(libs\/[\w.\-]+|icon-\d+\.png|favicon\.ico)$/.test(p)) {
      return serveStatic(res, p.slice(1));
    }
    if (!p.startsWith('/api/')) return err(res, 404, 'Ikke fundet');

    /* --- API --- */
    const user = currentUser(req);
    const isJson = (req.headers['content-type'] || '').includes('application/json');
    if (req.method !== 'GET' && !isJson) return err(res, 400, 'Content-Type skal være application/json');
    const body = req.method === 'GET' ? {} : await readBody(req);

    /* auth */
    if (p === '/api/register' && req.method === 'POST') {
      const total = q.userCount.get().n;
      const allowReg = total === 0 || setting('allow_registration', '1') === '1';
      if (!allowReg) return err(res, 403, 'Registrering af nye brugere er slået fra');
      const username = String(body.username || '').trim();
      if (!USERNAME_RE.test(username)) return err(res, 400, 'Brugernavn: 2-32 tegn (bogstaver, tal, . _ -)');
      if (!validPassword(body.password)) return err(res, 400, 'Kodeordet skal være mindst 8 tegn');
      if (q.userByName.get(username)) return err(res, 409, 'Brugernavnet er optaget');
      const salt = crypto.randomBytes(16).toString('hex');
      const info = q.insertUser.run(username, salt, hashPassword(body.password, salt), total === 0 ? 1 : 0, nowIso());
      createSession(res, Number(info.lastInsertRowid), ctx.secure);
      const nu = q.userById.get(Number(info.lastInsertRowid));
      console.log(`[bruger] oprettet: ${username}${total === 0 ? ' (admin)' : ''}`);
      return send(res, 200, { me: meJson(nu), firstUser: total === 0 });
    }
    if (p === '/api/login' && req.method === 'POST') {
      const key = (req.socket.remoteAddress || '') + '|' + String(body.username || '');
      if (rateLimited(key)) return err(res, 429, 'For mange forsøg – prøv igen om et kvarter');
      const usr = q.userByName.get(String(body.username || '').trim());
      if (!usr || !verifyPassword(usr, String(body.password || ''))) {
        noteAttempt(key);
        return err(res, 401, 'Forkert brugernavn eller kodeord');
      }
      createSession(res, usr.id, ctx.secure);
      return send(res, 200, { me: meJson(usr) });
    }
    if (p === '/api/logout' && req.method === 'POST') {
      if (user) q.deleteSession.run(user._token);
      res.setHeader('Set-Cookie', 'bogreol_session=; Path=/; Max-Age=0');
      return send(res, 200, { ok: true });
    }

    /* webauthn login (ingen session påkrævet) */
    if (p === '/api/webauthn/login/options' && req.method === 'POST') {
      const challenge = b64u(crypto.randomBytes(32));
      const challengeId = issueChallenge({ challenge, origin: ctx.origin, rpId: ctx.rpId, type: 'get' });
      return send(res, 200, {
        challengeId,
        publicKey: { challenge, rpId: ctx.rpId, timeout: 60000, userVerification: 'preferred', allowCredentials: [] }
      });
    }
    if (p === '/api/webauthn/login/verify' && req.method === 'POST') {
      const c = takeChallenge(String(body.challengeId || ''));
      if (!c || c.type !== 'get') return err(res, 400, 'Challenge er udløbet – prøv igen');
      const cred = q.credById.get(String(body.id || ''));
      if (!cred) return err(res, 401, 'Ukendt passkey');
      const cdJson = fromB64u(body.response && body.response.clientDataJSON);
      const authData = fromB64u(body.response && body.response.authenticatorData);
      const sig = fromB64u(body.response && body.response.signature);
      verifyClientData(cdJson, 'webauthn.get', c.challenge, c.origin);
      const ad = parseAuthData(authData);
      if (!ad.rpIdHash.equals(sha256(Buffer.from(c.rpId)))) return err(res, 401, 'Forkert rpId');
      if (!(ad.flags & 0x01)) return err(res, 401, 'Bruger ikke til stede');
      if (!verifyAssertionSignature(cred.jwk, authData, cdJson, sig)) return err(res, 401, 'Ugyldig signatur');
      if (ad.counter > 0 && cred.counter > 0 && ad.counter <= cred.counter) return err(res, 401, 'Ugyldig tæller (klonet nøgle?)');
      q.updateCounter.run(ad.counter, cred.id);
      const usr = q.userById.get(cred.user_id);
      if (!usr) return err(res, 401, 'Brugeren findes ikke længere');
      createSession(res, usr.id, ctx.secure);
      return send(res, 200, { me: meJson(usr) });
    }

    /* alt herunder kræver login */
    if (!user) return err(res, 401, 'Ikke logget ind');

    if (p === '/api/me' && req.method === 'GET') return send(res, 200, { me: meJson(user) });

    if (p === '/api/password' && req.method === 'POST') {
      if (!verifyPassword(user, String(body.current || ''))) return err(res, 401, 'Nuværende kodeord er forkert');
      if (!validPassword(body.password)) return err(res, 400, 'Nyt kodeord skal være mindst 8 tegn');
      const salt = crypto.randomBytes(16).toString('hex');
      q.setPassword.run(salt, hashPassword(body.password, salt), user.id);
      return send(res, 200, { ok: true });
    }

    /* webauthn registrering */
    if (p === '/api/webauthn/register/options' && req.method === 'POST') {
      const challenge = b64u(crypto.randomBytes(32));
      const challengeId = issueChallenge({ challenge, origin: ctx.origin, rpId: ctx.rpId, type: 'create', userId: user.id });
      return send(res, 200, {
        challengeId,
        publicKey: {
          challenge,
          rp: { name: APP_NAME, id: ctx.rpId },
          user: { id: b64u(Buffer.from('user-' + user.id)), name: user.username, displayName: user.username },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          timeout: 60000,
          attestation: 'none',
          authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
          excludeCredentials: q.credsByUser.all(user.id).map(c => ({ type: 'public-key', id: c.id }))
        }
      });
    }
    if (p === '/api/webauthn/register/verify' && req.method === 'POST') {
      const c = takeChallenge(String(body.challengeId || ''));
      if (!c || c.type !== 'create' || c.userId !== user.id) return err(res, 400, 'Challenge er udløbet – prøv igen');
      const cdJson = fromB64u(body.response && body.response.clientDataJSON);
      verifyClientData(cdJson, 'webauthn.create', c.challenge, c.origin);
      const [att] = cborDecodeFirst(fromB64u(body.response && body.response.attestationObject));
      const authData = att.get('authData');
      if (!Buffer.isBuffer(authData)) return err(res, 400, 'Manglende authData');
      const ad = parseAuthData(authData);
      if (!ad.rpIdHash.equals(sha256(Buffer.from(c.rpId)))) return err(res, 400, 'Forkert rpId');
      if (!ad.credId || !ad.cose) return err(res, 400, 'Ingen credential-data');
      const jwk = coseToJwk(ad.cose);
      const credId = b64u(ad.credId);
      if (q.credById.get(credId)) return err(res, 409, 'Denne passkey er allerede registreret');
      const label = String(body.label || '').slice(0, 100) || 'Passkey';
      q.insertCred.run(credId, user.id, JSON.stringify(jwk), ad.counter, label, nowIso());
      return send(res, 200, { me: meJson(user) });
    }
    if (p.startsWith('/api/webauthn/credentials/') && req.method === 'DELETE') {
      q.deleteCred.run(decodeURIComponent(p.slice('/api/webauthn/credentials/'.length)), user.id);
      return send(res, 200, { me: meJson(q.userById.get(user.id)) });
    }

    /* bøger */
    if (p === '/api/books' && req.method === 'GET') {
      const rows = q.booksByUser.all(user.id).map(r => JSON.parse(r.data));
      return send(res, 200, { books: rows });
    }
    if (p === '/api/books' && req.method === 'POST') {
      const b = sanitizeBook(body.book);
      if (!b || (!b.title && !b.deleted)) return err(res, 400, 'Ugyldig bog');
      const existing = q.bookById.get(b.id);
      if (existing && existing.user_id !== user.id) return err(res, 403, 'Ikke din bog');
      b.updatedAt = nowIso();
      q.upsertBook.run(b.id, user.id, JSON.stringify(b), b.updatedAt, b.deleted ? 1 : 0);
      return send(res, 200, { ok: true, updatedAt: b.updatedAt });
    }
    if (p === '/api/books/import' && req.method === 'POST') {
      const arr = Array.isArray(body.books) ? body.books.slice(0, 5000) : null;
      if (!arr) return err(res, 400, 'Forventede { books: [...] }');
      let n = 0;
      for (const raw of arr) {
        const b = sanitizeBook(raw);
        if (!b || !b.title) continue;
        const existing = q.bookById.get(b.id);
        if (existing && existing.user_id !== user.id) continue;
        q.upsertBook.run(b.id, user.id, JSON.stringify(b), b.updatedAt || nowIso(), b.deleted ? 1 : 0);
        n++;
      }
      return send(res, 200, { imported: n });
    }

    /* bogopslag via bibliotek.dk (danske boeger) - API'et sender ingen CORS-headers, saa serveren proxyer */
    if (p.startsWith('/api/lookup/isbn/') && req.method === 'GET') {
      const isbn = decodeURIComponent(p.slice('/api/lookup/isbn/'.length)).replace(/[^0-9Xx]/g, '');
      if (isbn.length !== 10 && isbn.length !== 13) return err(res, 400, 'Ugyldigt ISBN');
      try {
        const r = await fetch('https://bibliotek.dk/api/SimpleSearch/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(8000),
          body: JSON.stringify({
            query: 'query($q: SearchQueryInput!){ search(q:$q){ works(offset:0, limit:1){ titles{ full } creators{ display } series{ title numberInSeries } manifestations{ mostRelevant{ cover{ detail } identifiers{ type value } } } } } }',
            variables: { q: { all: isbn } }
          })
        });
        const j = await r.json();
        const w = j && j.data && j.data.search && j.data.search.works && j.data.search.works[0];
        if (!w) return send(res, 200, { found: false });
        // fritekst-soegningen kan fuzzy-matche - kraev at vaerkets egne ISBN'er indeholder det efterspurgte
        const wIsbns = ((w.manifestations && w.manifestations.mostRelevant) || [])
          .flatMap(m => m.identifiers || [])
          .filter(i => i.type === 'ISBN')
          .map(i => String(i.value).replace(/[^0-9Xx]/g, ''));
        if (!wIsbns.includes(isbn)) return send(res, 200, { found: false });
        const serie = (w.series && w.series[0]) || null;
        const numMatch = serie ? String(serie.numberInSeries || '').match(/\d+/) : null;
        const covers = (w.manifestations && w.manifestations.mostRelevant) || [];
        const cover = covers.find(m => m.cover && m.cover.detail);
        return send(res, 200, {
          found: true,
          title: (w.titles && w.titles.full && w.titles.full[0]) || '',
          authors: (w.creators || []).map(c => c.display).filter(Boolean),
          series: (serie && serie.title) || '',
          seriesNo: numMatch ? numMatch[0] : '',
          cover: (cover && cover.cover.detail) || ''
        });
      } catch (e) {
        return send(res, 200, { found: false });
      }
    }

    /* admin */
    if (p.startsWith('/api/admin/')) {
      if (!user.is_admin) return err(res, 403, 'Kræver administrator-rettigheder');

      if (p === '/api/admin/users' && req.method === 'GET') {
        return send(res, 200, {
          users: q.allUsers.all().map(x => ({
            id: x.id, username: x.username, isAdmin: !!x.is_admin,
            created: x.created_at, books: x.books, passkeys: x.passkeys
          })),
          allowRegistration: setting('allow_registration', '1') === '1'
        });
      }
      if (p === '/api/admin/settings' && req.method === 'POST') {
        if (typeof body.allowRegistration === 'boolean') {
          q.setSetting.run('allow_registration', body.allowRegistration ? '1' : '0');
        }
        return send(res, 200, { allowRegistration: setting('allow_registration', '1') === '1' });
      }
      const m = p.match(/^\/api\/admin\/users\/(\d+)(?:\/(password|role))?$/);
      if (m) {
        const targetId = parseInt(m[1], 10);
        const target = q.userById.get(targetId);
        if (!target) return err(res, 404, 'Brugeren findes ikke');

        if (m[2] === 'password' && req.method === 'POST') {
          if (!validPassword(body.password)) return err(res, 400, 'Kodeordet skal være mindst 8 tegn');
          const salt = crypto.randomBytes(16).toString('hex');
          q.setPassword.run(salt, hashPassword(body.password, salt), targetId);
          q.deleteUserSessions.run(targetId);
          console.log(`[admin] ${user.username} satte nyt kodeord for ${target.username}`);
          return send(res, 200, { ok: true });
        }
        if (m[2] === 'role' && req.method === 'POST') {
          const makeAdmin = !!body.isAdmin;
          if (!makeAdmin && target.is_admin && q.adminCount.get().n <= 1) {
            return err(res, 400, 'Kan ikke fjerne den sidste administrator');
          }
          q.setAdmin.run(makeAdmin ? 1 : 0, targetId);
          console.log(`[admin] ${user.username} ${makeAdmin ? 'gav' : 'fjernede'} admin for ${target.username}`);
          return send(res, 200, { ok: true });
        }
        if (!m[2] && req.method === 'DELETE') {
          if (targetId === user.id) return err(res, 400, 'Du kan ikke slette dig selv');
          if (target.is_admin && q.adminCount.get().n <= 1) return err(res, 400, 'Kan ikke slette den sidste administrator');
          q.deleteUserSessions.run(targetId);
          q.deleteUserCreds.run(targetId);
          q.deleteUserBooks.run(targetId);
          q.deleteUser.run(targetId);
          console.log(`[admin] ${user.username} slettede brugeren ${target.username}`);
          return send(res, 200, { ok: true });
        }
      }
    }

    return err(res, 404, 'Ukendt endpoint');
  } catch (e) {
    console.error('[fejl]', req.method, p, e.message);
    return err(res, 500, 'Serverfejl: ' + e.message);
  }
});

setInterval(() => { try { q.purgeSessions.run(nowIso()); } catch (e) {} }, 6 * 3600e3).unref();

server.listen(BIND_PORT, () => {
  console.log(`${APP_NAME}: Bogreol lytter på port ${BIND_PORT} (data: ${path.join(DATA_DIR, 'bogreol.db')})`);
});
