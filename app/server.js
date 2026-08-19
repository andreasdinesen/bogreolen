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

/* Skemaaendringer efter grundskemaet: en liste af migrationer styret af PRAGMA
 * user_version, saa en ny kolonne/tabel aldrig kraever en manuel ALTER-dans. */
const MIGRATIONS = [
  db => db.exec(`
    /* Vedvarende rate-limit: in-memory nulstilles ved hver genstart, og panelet
     * genstarter automatisk kl. 04. */
    CREATE TABLE IF NOT EXISTS rate (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
    /* Adgangsnoegler til API/MCP. OAuth-udstedte access-tokens faar IKKE deres egen
     * tabel - de ligger her med client_id + expires_at, saa de valideres ad praecis
     * samme vej som en haandlavet noegle. Noeglen gemmes kun som sha256. */
    CREATE TABLE IF NOT EXISTS tokens (
      hash TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      label TEXT NOT NULL,
      scope TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      client_id TEXT,
      created_at TEXT NOT NULL,
      expires_at INTEGER,
      last_used_at TEXT,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens(user_id);
    CREATE TABLE IF NOT EXISTS oauth_clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      redirect_uris TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_refresh (
      hash TEXT PRIMARY KEY,
      token_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
  `),
  /* Egne cover-billeder ud af bog-JSON'en og over i deres egen tabel (Kokkeri §4:
   * billeder inde i de items, listen henter, skalerer ikke). Bogen beholder kun et
   * `coverVer`-stempel; billedet serveres paa /api/cover/<id>?v=<ver> med ETag +
   * immutable, saa indholdet aldrig kan skifte bag om cachen. */
  db => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS covers (
        book_id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        mime TEXT NOT NULL,
        bytes BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_covers_user ON covers(user_id);
    `);
    const ind = db.prepare('INSERT OR REPLACE INTO covers (book_id, user_id, mime, bytes, updated_at) VALUES (?,?,?,?,?)');
    const upd = db.prepare('UPDATE books SET data = ? WHERE id = ?');
    let n = 0;
    for (const row of db.prepare('SELECT id, user_id, data FROM books').all()) {
      let b;
      try { b = JSON.parse(row.data); } catch (e) { continue; }
      const m = typeof b.cover === 'string' && b.cover.match(/^data:([\w/+.-]+);base64,(.*)$/s);
      if (!m) continue;
      const nu = new Date().toISOString();
      ind.run(row.id, row.user_id, m[1], Buffer.from(m[2], 'base64'), nu);
      b.cover = '';
      b.coverVer = Date.parse(nu);
      upd.run(JSON.stringify(b), row.id);
      n++;
    }
    if (n) console.log(`[db] flyttede ${n} indlejrede covers ud af bog-JSON'en`);
  }
];
(function migrate() {
  const cur = db.prepare('PRAGMA user_version').get().user_version || 0;
  for (let i = cur; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try { MIGRATIONS[i](db); db.exec(`PRAGMA user_version = ${i + 1}`); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
    console.log(`[db] skema opdateret til version ${i + 1}`);
  }
})();

const q = {
  // Brugernavne sammenlignes uden hensyn til store/smaa bogstaver (login, registrering, dubletcheck).
  userByName: db.prepare('SELECT * FROM users WHERE lower(username) = lower(?)'),
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
  insertCover: db.prepare('INSERT OR REPLACE INTO covers (book_id, user_id, mime, bytes, updated_at) VALUES (?,?,?,?,?)'),
  getCover: db.prepare('SELECT * FROM covers WHERE book_id = ? AND user_id = ?'),
  deleteCover: db.prepare('DELETE FROM covers WHERE book_id = ? AND user_id = ?'),
  deleteUserCovers: db.prepare('DELETE FROM covers WHERE user_id = ?'),
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
};

const nowIso = () => new Date().toISOString();
const s2 = v => String(v == null ? '' : v).slice(0, 40);
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

/* Ruller op i panelets sikkerhedshistorik via runens events:-blok. */
const logSecurity = msg => console.warn(`[sikkerhed] ${msg}`);
const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

/* Vedvarende rate-limit (tabel `rate`). rateCount = antal i vinduet; rateNote = taeller én op. */
const rq = {
  get: db.prepare('SELECT count, reset_at FROM rate WHERE bucket = ?'),
  start: db.prepare('INSERT INTO rate (bucket, count, reset_at) VALUES (?,1,?) ON CONFLICT(bucket) DO UPDATE SET count = 1, reset_at = excluded.reset_at'),
  bump: db.prepare('UPDATE rate SET count = count + 1 WHERE bucket = ?'),
  clear: db.prepare('DELETE FROM rate WHERE bucket = ?'),
  purge: db.prepare('DELETE FROM rate WHERE reset_at < ?')
};
const nowSec = () => Math.floor(Date.now() / 1000);
function rateCount(bucket) {
  const r = rq.get.get(bucket);
  return r && r.reset_at > nowSec() ? r.count : 0;
}
function rateNote(bucket, windowSec) {
  const r = rq.get.get(bucket);
  if (!r || r.reset_at <= nowSec()) rq.start.run(bucket, nowSec() + windowSec);
  else rq.bump.run(bucket);
}
const rateClear = bucket => rq.clear.run(bucket);

/* ---------------- adgangsnoegler (API/MCP) ---------------- */
const sha256hex = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const tq = {
  insertToken: db.prepare(`INSERT INTO tokens (hash, id, label, scope, user_id, client_id, created_at, expires_at)
                           VALUES (?,?,?,?,?,?,?,?)`),
  // Udloebstjekket SKAL staa i opslaget - ellers lever OAuth-tokens evigt.
  findToken: db.prepare(`SELECT * FROM tokens WHERE hash = ? AND revoked_at IS NULL
                         AND (expires_at IS NULL OR expires_at > ?)`),
  touchToken: db.prepare('UPDATE tokens SET last_used_at = ? WHERE hash = ?'),
  revokeToken: db.prepare('UPDATE tokens SET revoked_at = ? WHERE id = ? AND user_id = ?'),
  revokeByHash: db.prepare('UPDATE tokens SET revoked_at = ? WHERE hash = ?'),
  revokeByClient: db.prepare('UPDATE tokens SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL'),
  // Egne noegler er dem UDEN client_id; OAuth-tokens hoerer under "forbundne apps".
  ownKeys: db.prepare(`SELECT id, label, scope, created_at, last_used_at FROM tokens
                       WHERE user_id = ? AND client_id IS NULL AND revoked_at IS NULL ORDER BY created_at DESC`),
  // En registrering er ikke en forbindelse: klienten registrerer sig ved hvert forsoeg,
  // ogsaa dem man siger nej til - derfor EXISTS paa aktive tokens.
  connections: db.prepare(`SELECT c.id, c.name, c.created_at,
                             (SELECT max(t.created_at) FROM tokens t WHERE t.client_id = c.id AND t.user_id = ?) AS last_token
                           FROM oauth_clients c
                           WHERE EXISTS (SELECT 1 FROM tokens t WHERE t.client_id = c.id AND t.user_id = ? AND t.revoked_at IS NULL)
                           ORDER BY c.created_at DESC`),
  insertClient: db.prepare('INSERT OR REPLACE INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?,?,?,?)'),
  getClient: db.prepare('SELECT * FROM oauth_clients WHERE id = ?'),
  insertRefresh: db.prepare(`INSERT INTO oauth_refresh (hash, token_id, client_id, scope, user_id, created_at)
                             VALUES (?,?,?,?,?,?)`),
  findRefresh: db.prepare('SELECT * FROM oauth_refresh WHERE hash = ? AND revoked_at IS NULL'),
  revokeRefresh: db.prepare('UPDATE oauth_refresh SET revoked_at = ? WHERE hash = ?'),
  revokeRefreshByClient: db.prepare('UPDATE oauth_refresh SET revoked_at = ? WHERE client_id = ? AND user_id = ? AND revoked_at IS NULL'),
  sweepClients: db.prepare(`DELETE FROM oauth_clients WHERE created_at < ?
                            AND NOT EXISTS (SELECT 1 FROM tokens t WHERE t.client_id = oauth_clients.id)`)
};
function nyToken(userId, label, scope, clientId, levetidSek) {
  const raw = 'br_' + crypto.randomBytes(24).toString('base64url');
  const id = crypto.randomBytes(8).toString('hex');
  tq.insertToken.run(sha256hex(raw), id, label, scope, userId, clientId || null, nowIso(),
    levetidSek ? nowSec() + levetidSek : null);
  return { raw, id };
}
/* Bearer-noegle fra Authorization-headeren -> token-raekke (eller null). last_used_at
 * skrives hoejst én gang i minuttet, saa hvert kald ikke koster en skrivning. */
function tokenFra(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const row = tq.findToken.get(sha256hex(m[1].trim()), nowSec());
  if (!row) return null;
  if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > 60e3) tq.touchToken.run(nowIso(), row.hash);
  return row;
}
/* Ét API, to slags legitimation: session-cookie ELLER Bearer-noegle. Auth-/admin-/
 * noegle-ruterne bliver paa ren session (requireUser) - en connector maa aldrig kunne
 * administrere sig selv. */
function godkend(req) {
  const u = currentUser(req);
  if (u) return { user: u, viaToken: false, scope: 'full' };
  const t = tokenFra(req);
  if (!t) return null;
  const usr = q.userById.get(t.user_id);
  if (!usr) return null;
  return { user: usr, viaToken: true, scope: t.scope, token: t };
}
/* Server-hemmelighed til hmac (samtykke-CSRF) - genereres én gang. */
if (!setting('server_secret', '')) q.setSetting.run('server_secret', crypto.randomBytes(32).toString('hex'));
const SERVER_SECRET = setting('server_secret', '');

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
      // HTML altid frisk (Cloudflare cacher ikke HTML som standard, men ignorerer no-cache paa assets)
      'Cache-Control': relPath.startsWith('libs/') ? 'public, max-age=604800' : (relPath.endsWith('.html') ? 'no-store' : 'no-cache'),
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
    // cover = ekstern URL. Egne billeder ligger i covers-tabellen og kendes paa coverVer.
    cover: /^data:/.test(String(b.cover || '')) ? '' : s(b.cover).slice(0, 2000),
    coverVer: Number.isFinite(Number(b.coverVer)) && Number(b.coverVer) > 0 ? Number(b.coverVer) : null,
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

/* ---------------- bibliotek.dk (fælles for REST-proxy og MCP) ---------------- */
async function bibliotekDk(query, variables) {
  const r = await fetch('https://bibliotek.dk/api/SimpleSearch/graphql', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8000),
    body: JSON.stringify({ query, variables })
  });
  const j = await r.json();
  return j && j.data && j.data.search && j.data.search.works && j.data.search.works[0];
}
const wSerie = w => { const s = (w.series && w.series[0]) || null; const n = s ? String(s.numberInSeries || '').match(/\d+/) : null; return { series: (s && s.title) || '', seriesNo: n ? n[0] : '' }; };
const wIsbnOf = m => { const id = (m.identifiers || []).find(i => i.type === 'ISBN'); return id ? String(id.value).replace(/[^0-9Xx]/g, '') : ''; };
async function lookupIsbnBibliotek(isbn) {
  try {
    const w = await bibliotekDk('query($q: SearchQueryInput!){ search(q:$q){ works(offset:0, limit:1){ titles{ full } creators{ display } series{ title numberInSeries } manifestations{ mostRelevant{ cover{ detail } identifiers{ type value } } } } } }', { q: { all: isbn } });
    if (!w) return { found: false };
    const mans = (w.manifestations && w.manifestations.mostRelevant) || [];
    // fritekst-soegningen kan fuzzy-matche - kraev at vaerkets egne ISBN'er indeholder det efterspurgte
    if (!mans.map(wIsbnOf).includes(isbn)) return { found: false };
    const cover = mans.find(m => m.cover && m.cover.detail);
    return Object.assign({
      found: true, title: (w.titles && w.titles.full && w.titles.full[0]) || '',
      authors: (w.creators || []).map(c => c.display).filter(Boolean), cover: (cover && cover.cover.detail) || ''
    }, wSerie(w));
  } catch (e) { return { found: false }; }
}
async function lookupSearchBibliotek(qtext) {
  try {
    const w = await bibliotekDk('query($q: SearchQueryInput!){ search(q:$q){ works(offset:0, limit:1){ titles{ full } creators{ display } series{ title numberInSeries } manifestations{ mostRelevant{ identifiers{ type value } materialTypes{ materialTypeGeneral{ code } } cover{ detail } } } } } }', { q: { all: qtext } });
    if (!w) return { found: false };
    const mans = (w.manifestations && w.manifestations.mostRelevant) || [];
    const isBook = m => (m.materialTypes || []).some(t => t.materialTypeGeneral && t.materialTypeGeneral.code === 'BOOKS');
    const best = mans.find(m => isBook(m) && wIsbnOf(m)) || mans.find(m => wIsbnOf(m)) || null;
    const withCover = (best && best.cover && best.cover.detail) ? best : mans.find(m => m.cover && m.cover.detail);
    return Object.assign({
      found: true, title: (w.titles && w.titles.full && w.titles.full[0]) || '',
      authors: (w.creators || []).map(c => c.display).filter(Boolean),
      isbn: best ? wIsbnOf(best) : '', cover: (withCover && withCover.cover.detail) || ''
    }, wSerie(w));
  } catch (e) { return { found: false }; }
}

/* ---------------- OAuth 2.1 + MCP ---------------- */
const APP_VERSION_TXT = (() => {
  try { return (fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8').match(/const APP_VERSION = (\d+);/) || [])[1] || '0'; }
  catch (e) { return '0'; }
})();
const oauth = require('./oauth.js').opret({
  gemKlient: k => tq.insertClient.run(k.id, k.name, k.redirect_uris, nowSec()),
  hentKlient: id => tq.getClient.get(id) || null,
  udstedTokens: (clientId, scope, userId) => {
    const t = nyToken(userId, 'Connector', scope, clientId, oauth.ADGANG_LEVETID);
    const refresh = crypto.randomBytes(32).toString('base64url');
    tq.insertRefresh.run(sha256hex(refresh), t.id, clientId, scope, userId, nowSec());
    return { access_token: t.raw, token_type: 'Bearer', expires_in: oauth.ADGANG_LEVETID, refresh_token: refresh, scope };
  },
  findRefresh: r => tq.findRefresh.get(sha256hex(r)) || null,
  tilbagekaldRefresh: r => tq.revokeRefresh.run(nowSec(), sha256hex(r))
});
/* Egne cover-billeder gemmes ALDRIG i bog-JSON'en (Kokkeri §4). Sendes der en
 * data-URL med (upload, JSON-import, gammel backup), lander billedet i covers-tabellen,
 * og bogen faar kun et coverVer-stempel. Returnerer bogen med rettede felter. */
const COVER_MIME = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'];
function udtraekCover(userId, b, raw) {
  const m = typeof (raw && raw.cover) === 'string' && raw.cover.match(/^data:([\w/+.-]+);base64,(.*)$/s);
  if (!m) return b;
  if (!COVER_MIME.includes(m[1])) throw new Error('Ukendt billedtype');
  const bytes = Buffer.from(m[2], 'base64');
  if (!bytes.length) return b;
  if (bytes.length > 400000) throw new Error('Billedet er for stort');
  b.cover = '';
  b.coverVer = Date.now();
  q.insertCover.run(b.id, userId, m[1], bytes, nowIso());
  return b;
}
/* Bogfunktioner til MCP: SAMME vej som webappen (sanitizeBook + upsert). */
function saveBookFor(userId, raw) {
  let b = sanitizeBook(raw);
  if (!b || (!b.title && !b.deleted)) throw new Error('Ugyldig bog');
  const existing = q.bookById.get(b.id);
  if (existing && existing.user_id !== userId) throw new Error('Ikke din bog');
  b = udtraekCover(userId, b, raw);
  b.updatedAt = nowIso();
  q.upsertBook.run(b.id, userId, JSON.stringify(b), b.updatedAt, b.deleted ? 1 : 0);
  return b;
}
const mcp = require('./mcp.js').opret({
  version: APP_VERSION_TXT,
  nytId: () => crypto.randomUUID(),
  booksFor: userId => q.booksByUser.all(userId).map(r => JSON.parse(r.data)),
  saveBook: saveBookFor,
  lookupIsbn: lookupIsbnBibliotek,
  lookupSearch: lookupSearchBibliotek,
  godkendMcp: req => { const t = tokenFra(req); if (!t) return null; const usr = q.userById.get(t.user_id); return usr ? { token: t, user: usr } : null; },
  // "read" maa laese; "full" maa alt. tools/list filtreres med samme funktion.
  maa: (auth, scope) => scope === 'read' ? true : auth.token.scope === 'full',
  oauthUdfordring: req => `Bearer realm="Min Bogreol", resource_metadata="${oauth.base(req)}/.well-known/oauth-protected-resource/mcp"`,
  readMcpBody: req => readBody(req, 1e6),
  logError: m => console.error('[fejl] ' + m)
});

/* De offentlige OAuth-endepunkter skal kunne laeses paa tvaers af oprindelser
 * (claude.ai henter dem fra sin egen browser), saa de gaar uden om send(). */
function sendPublic(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(body);
}
function readRaw(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > (maxBytes || 1e6)) { reject(new Error('For stor')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
/* /oauth/token kaldes med form-encoding af nogle klienter og JSON af andre */
async function readFormOrJson(req) {
  const raw = await readRaw(req, 1e6);
  if (String(req.headers['content-type'] || '').includes('application/json')) { try { return JSON.parse(raw || '{}'); } catch (e) { return {}; } }
  const ud = {};
  for (const [k, v] of new URLSearchParams(raw)) ud[k] = v;
  return ud;
}
const htmlEsc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

/* Samtykkesiden er appens ENESTE cookie-godkendte rute uden JSON-krop og staar derfor
 * uden for CSRF-barrieren i /api. Den faar sin egen spaerre: et skjult felt bundet til
 * sessionscookien. Sammenlign BUFFERLAENGDER, ikke strenglaengder. */
const consentCsrf = token => crypto.createHmac('sha256', SERVER_SECRET).update('oauth-consent:' + token).digest('hex');
function consentCsrfOk(token, sendt) {
  const a = Buffer.from(consentCsrf(token)), b = Buffer.from(String(sendt || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/* Samtykkesiden arver appens udseende: index.html's <style> og tema-scriptet indsaettes
 * ordret (frontenden er én fil uden separat style.css). Ingen JavaScript ud over tema-init. */
const INDEX_STYLE = (() => {
  try {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    return { css: (html.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1], theme: (html.match(/<script data-theme-init>[\s\S]*?<\/script>/) || [''])[0] };
  } catch (e) { return { css: '', theme: '' }; }
})();
function consentSide(o, token, vaert) {
  return `<!doctype html><html lang="da"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Giv adgang til ${htmlEsc(APP_NAME)}</title>
${INDEX_STYLE.theme}
<style>${INDEX_STYLE.css}</style>
</head><body class="loggedout">
<section class="view active" id="view-login" style="max-width:420px; margin:0 auto; padding:8vh 16px 40px">
  <div class="loginlogo">📚</div>
  <h1 style="text-align:center">Giv adgang?</h1>
  <p class="loginsub"><b>${htmlEsc(o.klient.name)}</b> vil have adgang til ${htmlEsc(APP_NAME)} på ${htmlEsc(vaert)}.</p>
  <div class="panel">
    <div class="muted">Adgangen omfatter <b>${o.scope === 'read' ? 'kun læsning' : 'læsning og skrivning'}</b> af dit bibliotek:
      bøger, læst/ejet/ønskeliste, udlån, vurderinger og noter. Den kan ikke skifte dit kodeord, oprette nøgler eller fjerne forbindelser.</div>
    <form method="post" action="/oauth/authorize" style="margin-top:14px">
      <input type="hidden" name="csrf" value="${htmlEsc(consentCsrf(token))}">
      <input type="hidden" name="client_id" value="${htmlEsc(o.klient.id)}">
      <input type="hidden" name="redirect_uri" value="${htmlEsc(o.redirect)}">
      <input type="hidden" name="code_challenge" value="${htmlEsc(o.udfordring)}">
      <input type="hidden" name="scope" value="${htmlEsc(o.scope)}">
      <input type="hidden" name="state" value="${htmlEsc(o.state)}">
      <button class="btn" type="submit" name="godkend" value="ja">Giv adgang</button>
      <button class="btn sec" type="submit" name="godkend" value="nej">Afvis</button>
    </form>
    <div class="muted" style="margin-top:10px; font-size:0.75rem">Returadresse: ${htmlEsc(o.redirect)}</div>
  </div>
</section></body></html>`;
}
function sendHtml(res, code, html) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}
const lilleSide = (code, tekst) => `<!doctype html><meta charset="utf-8"><p style="font-family:system-ui;padding:20px">${htmlEsc(tekst)}</p>`;

async function oauthRute(req, res, u, p) {
  if (req.method === 'OPTIONS') return sendPublic(res, 204, {});

  if (p === '/oauth/register' && req.method === 'POST') {
    // Saet graensen HOEJT: rammes den, findes klienten aldrig, og brugeren faar "ukendt
    // klient" paa samtykkesiden - en fejl der peger et andet sted hen end aarsagen.
    const key = 'oauthreg|' + clientIp(req);
    if (rateCount(key) >= 60) return sendPublic(res, 429, { error: 'too_many_requests' });
    rateNote(key, 3600);
    const r = oauth.registrer(await readFormOrJson(req));
    if (r.fejl) return sendPublic(res, 400, { error: 'invalid_redirect_uri', error_description: r.fejl });
    return sendPublic(res, 201, r.klient);
  }

  if (p === '/oauth/authorize' && req.method === 'GET') {
    const bruger = currentUser(req);
    if (!bruger) {
      // Send til login og tilbage bagefter. Frontenden whitelister stien (kun /oauth/authorize?).
      res.writeHead(302, { Location: '/?next=' + encodeURIComponent(p + u.search) });
      return res.end();
    }
    const o = oauth.tjekAutorisation(u.searchParams);
    if (o.fejl) return sendHtml(res, 400, lilleSide(400, o.fejl));
    return sendHtml(res, 200, consentSide(o, bruger._token, oauth.base(req).replace(/^https?:\/\//, '')));
  }

  if (p === '/oauth/authorize' && req.method === 'POST') {
    const bruger = currentUser(req);
    if (!bruger) return sendHtml(res, 401, lilleSide(401, 'Log ind først.'));
    const f = await readFormOrJson(req);
    if (!consentCsrfOk(bruger._token, f.csrf)) return sendHtml(res, 403, lilleSide(403, 'Formularen er udløbet. Prøv igen.'));
    const qs = new URLSearchParams({
      client_id: f.client_id || '', redirect_uri: f.redirect_uri || '', response_type: 'code',
      code_challenge: f.code_challenge || '', code_challenge_method: 'S256', scope: f.scope || 'full', state: f.state || ''
    });
    const o = oauth.tjekAutorisation(qs);
    if (o.fejl) return sendHtml(res, 400, lilleSide(400, o.fejl));
    if (f.godkend !== 'ja') {
      // Afvisning skal meldes tilbage, ellers staar klienten og venter paa en kode, der aldrig kommer.
      const url = new URL(o.redirect);
      url.searchParams.set('error', 'access_denied');
      if (o.state) url.searchParams.set('state', o.state);
      res.writeHead(302, { Location: url.toString() });
      return res.end();
    }
    console.log(`[oauth] ${bruger.username} gav ${o.klient.name} adgang (${o.scope})`);
    res.writeHead(302, { Location: oauth.giveTilladelse(o, bruger.id) });
    return res.end();
  }

  if (p === '/oauth/token' && req.method === 'POST') {
    const krop = await readFormOrJson(req);
    let r;
    if (krop.grant_type === 'authorization_code') r = oauth.byttKode(krop);
    else if (krop.grant_type === 'refresh_token') r = oauth.forny(krop);
    else return sendPublic(res, 400, { error: 'unsupported_grant_type' });
    if (r.fejl) return sendPublic(res, 400, { error: r.fejl });
    return sendPublic(res, 200, r);
  }

  if (p === '/oauth/revoke' && req.method === 'POST') {
    const krop = await readFormOrJson(req);
    const t = String(krop.token || '');
    tq.revokeRefresh.run(nowSec(), sha256hex(t));
    const row = tq.findToken.get(sha256hex(t), nowSec());
    if (row) tq.revokeByHash.run(nowIso(), row.hash);
    return sendPublic(res, 200, {});
  }

  return err(res, 404, 'Ikke fundet');
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
    /* --- MCP + OAuth (ligger uden for /api/ og har deres egen godkendelse) --- */
    if (p === '/mcp') return await mcp.haandter(req, res);
    // RFC 9728 haenger ressourcens sti paa, men flere klienter proever den noegne form
    // foerst - servér begge, ellers fejler opdagelsen tavst.
    if (req.method === 'GET' && /^\/\.well-known\/oauth-protected-resource(\/mcp)?$/.test(p)) return sendPublic(res, 200, oauth.beskyttetRessource(req));
    if (req.method === 'GET' && /^\/\.well-known\/oauth-authorization-server(\/mcp)?$/.test(p)) return sendPublic(res, 200, oauth.serverMetadata(req));
    if (p.startsWith('/oauth/')) return await oauthRute(req, res, u, p);

    if (!p.startsWith('/api/')) return err(res, 404, 'Ikke fundet');

    /* --- API --- */
    /* Ét API, to slags legitimation: session-cookie eller Bearer-noegle. Kravet om
     * application/json er en CSRF-barriere og forudsaetter en ambient legitimation -
     * en Bearer-noegle sendes aktivt, saa dér er der intet at forfalske. */
    const auth = godkend(req);
    const user = auth ? auth.user : null;
    const viaToken = !!(auth && auth.viaToken);
    const isJson = (req.headers['content-type'] || '').includes('application/json');
    if (req.method !== 'GET' && !isJson && !viaToken) return err(res, 400, 'Content-Type skal være application/json');
    let body = {};
    if (req.method !== 'GET') {
      try { body = await readBody(req); } catch (e) { return err(res, 400, e.message); }
    }
    if (viaToken) {
      // Noegler naar kun data-ruterne. Kodeord, passkeys, admin og noeglerne selv kraever en
      // rigtig session - ellers er én laekket noegle nok til varig fuld adgang.
      if (!/^\/api\/(books|lookup|cover)(\/|$)/.test(p)) return err(res, 403, 'API-nøgler har kun adgang til bøger og opslag – log ind i appen for resten');
      if (auth.scope !== 'full' && req.method !== 'GET') return err(res, 403, 'Denne API-nøgle er kun til læsning');
    }

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
      const ip = clientIp(req);
      const key = 'login|' + ip + '|' + String(body.username || '').toLowerCase();
      if (rateCount(key) >= 15) {
        logSecurity(`login-spaerret ip=${ip}`);
        return err(res, 429, 'For mange forsøg – prøv igen om et kvarter');
      }
      const usr = q.userByName.get(String(body.username || '').trim());
      if (!usr || !verifyPassword(usr, String(body.password || ''))) {
        rateNote(key, 15 * 60);
        logSecurity(`login-fejl ip=${ip} bruger=${String(body.username || '').slice(0, 40)}`);
        return err(res, 401, 'Forkert brugernavn eller kodeord');
      }
      rateClear(key);
      createSession(res, usr.id, ctx.secure);
      return send(res, 200, { me: meJson(usr) });
    }
    /* offentlig konfiguration (ingen login): skjuler registreringslinket naar registrering er lukket */
    if (p === '/api/public-config' && req.method === 'GET') {
      const total = q.userCount.get().n;
      // Den version, SERVEREN udleverer. Stemmer den ikke med den APP_VERSION,
      // browseren koerer, sidder der en gammel side i cachen (typisk en PWA paa
      // hjemmeskaermen, der aldrig genindlaeses) - og saa skal brugeren vide det.
      return send(res, 200, {
        appName: APP_NAME,
        version: Number(APP_VERSION_TXT) || 0,
        allowRegistration: total === 0 || setting('allow_registration', '1') === '1'
      });
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

    /* --- adgangsnoegler og forbundne apps (kun session - en connector maa aldrig administrere sig selv) --- */
    if (p === '/api/keys' && req.method === 'GET') {
      return send(res, 200, { keys: tq.ownKeys.all(user.id), connections: tq.connections.all(user.id, user.id), mcpUrl: oauth.base(req) + '/mcp' });
    }
    if (p === '/api/keys' && req.method === 'POST') {
      const label = String(body.label || '').trim().slice(0, 60) || 'Nøgle';
      const scope = body.scope === 'read' ? 'read' : 'full';
      const t = nyToken(user.id, label, scope, null, null);
      console.log(`[noegle] ${user.username} oprettede noeglen "${label}" (${scope})`);
      // Noeglen vises ÉN gang - den gemmes kun som sha256.
      return send(res, 200, { token: t.raw, id: t.id, label, scope });
    }
    if (p === '/api/keys' && req.method === 'DELETE') {
      tq.revokeToken.run(nowIso(), String(body.id || ''), user.id);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/connections' && req.method === 'DELETE') {
      // Tilbagekaldelse skal ramme BAADE access- og refresh-tokens for klienten (kun brugerens egne).
      const cid = String(body.clientId || '');
      db.prepare('UPDATE tokens SET revoked_at = ? WHERE client_id = ? AND user_id = ? AND revoked_at IS NULL').run(nowIso(), cid, user.id);
      tq.revokeRefreshByClient.run(nowSec(), cid, user.id);
      return send(res, 200, { ok: true });
    }

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
      let b;
      try { b = saveBookFor(user.id, body.book); }
      catch (e) { return err(res, e.message === 'Ikke din bog' ? 403 : 400, e.message); }
      return send(res, 200, { ok: true, updatedAt: b.updatedAt, coverVer: b.coverVer });
    }
    if (p === '/api/books/import' && req.method === 'POST') {
      const arr = Array.isArray(body.books) ? body.books.slice(0, 5000) : null;
      if (!arr) return err(res, 400, 'Forventede { books: [...] }');
      let n = 0;
      for (const raw of arr) {
        // Samme skrivevej som resten: en gammel backup med indlejret cover pakkes ud
        // i covers-tabellen i stedet for at lande i bog-JSON'en igen.
        try {
          const b = sanitizeBook(raw);
          if (!b || !b.title) continue;
          const existing = q.bookById.get(b.id);
          if (existing && existing.user_id !== user.id) continue;
          const gemt = udtraekCover(user.id, b, raw);
          gemt.updatedAt = s2(raw.updatedAt) || nowIso();
          q.upsertBook.run(gemt.id, user.id, JSON.stringify(gemt), gemt.updatedAt, gemt.deleted ? 1 : 0);
          n++;
        } catch (e) { /* spring en enkelt daarlig raekke over */ }
      }
      return send(res, 200, { imported: n });
    }

    /* eget cover-billede. Versioneret URL + immutable = browseren spoerger aldrig igen,
     * og listesvaret slipper for hundredtusindvis af base64-tegn. */
    if (p.startsWith('/api/cover/') && req.method === 'GET') {
      const id = decodeURIComponent(p.slice('/api/cover/'.length)).split('?')[0];
      const row = q.getCover.get(id, user.id);
      if (!row) return err(res, 404, 'Intet cover');
      const etag = '"' + crypto.createHash('sha256').update(row.bytes).digest('hex').slice(0, 32) + '"';
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); return res.end(); }
      res.writeHead(200, {
        'Content-Type': row.mime,
        'Content-Length': row.bytes.length,
        ETag: etag,
        'Cache-Control': 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff'
      });
      return res.end(row.bytes);
    }

    /* bogopslag via bibliotek.dk (danske boeger) - API'et sender ingen CORS-headers, saa serveren proxyer.
     * Samme funktioner bruges af MCP-vaerktoejerne lookup_isbn/search_catalog. */
    if (p.startsWith('/api/lookup/isbn/') && req.method === 'GET') {
      const isbn = decodeURIComponent(p.slice('/api/lookup/isbn/'.length)).replace(/[^0-9Xx]/g, '');
      if (isbn.length !== 10 && isbn.length !== 13) return err(res, 400, 'Ugyldigt ISBN');
      return send(res, 200, await lookupIsbnBibliotek(isbn));
    }
    /* fritekst-opslag (titel + forfatter) - bruges af berigelses-funktionen til boeger uden ISBN */
    if (p === '/api/lookup/search' && req.method === 'GET') {
      const qtext = String(u.searchParams.get('q') || '').trim().slice(0, 200);
      if (!qtext) return err(res, 400, 'Mangler soegetekst');
      return send(res, 200, await lookupSearchBibliotek(qtext));
    }

    /* cover-proxy til eksport med billeder: browseren kan ikke laese cross-origin billeddata (canvas-taint) */
    if (p === '/api/lookup/cover' && req.method === 'GET') {
      const COVER_HOSTS = ['covers.openlibrary.org', 'books.google.com', 'fbiinfo-present.dbc.dk'];
      let target;
      try { target = new URL(String(u.searchParams.get('url') || '')); } catch (e) { return err(res, 400, 'Ugyldig URL'); }
      if (target.protocol !== 'https:' && target.protocol !== 'http:') return err(res, 400, 'Ugyldig URL');
      if (!COVER_HOSTS.includes(target.hostname)) return err(res, 403, 'Ukendt billed-kilde');
      try {
        const r = await fetch(target, { signal: AbortSignal.timeout(10000), redirect: 'follow' });
        const ct = r.headers.get('content-type') || '';
        if (!r.ok || !ct.startsWith('image/')) return err(res, 404, 'Intet billede');
        const ab = await r.arrayBuffer();
        if (ab.byteLength > 3000000) return err(res, 413, 'Billedet er for stort');
        res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'private, max-age=3600' });
        return res.end(Buffer.from(ab));
      } catch (e) {
        return err(res, 502, 'Kunne ikke hente billedet');
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
          q.deleteUserCovers.run(targetId);
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

setInterval(() => {
  try { q.purgeSessions.run(nowIso()); rq.purge.run(nowSec()); } catch (e) {}
}, 6 * 3600e3).unref();
/* Ryd OAuth-registreringer op, der aldrig blev til en forbindelse (én gang i doegnet) */
setInterval(() => { try { tq.sweepClients.run(nowSec() - 7 * 86400); } catch (e) {} }, 24 * 3600e3).unref();

server.listen(BIND_PORT, () => {
  // Skriv den port der FAKTISK blev bundet - ikke oensket - saa en portfejl kan ses i loggen.
  console.log(`${APP_NAME}: Bogreol lytter på port ${server.address().port} (data: ${path.join(DATA_DIR, 'bogreol.db')})`);
});
