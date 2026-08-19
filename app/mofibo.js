'use strict';
/*
 * Min Bogreol - Mofibo/Storytel-integration.
 *
 * Henter FAERDIGLAESTE boeger fra brugerens egen Mofibo-reol og laegger dem i
 * biblioteket som »laest, men ikke ejet«. Ingen npm-pakker: login-kodeordet
 * krypteres med node:crypto, og resten er to https-kald.
 *
 * VIGTIGT om API'et (undersoegt 2026-08-19):
 *  - Det er UOFFICIELT. Storytel har allerede skiftet det én gang (det gamle
 *    getBookShelf.action er afloest af api.storytel.net/libraries/bookshelf).
 *    Derfor: fejl skal vaere synlige og forklarende, aldrig tavse.
 *  - Det gamle endpoint svarer 200 med en TOM liste paa et ugyldigt token -
 *    altsaa "ingen boeger" i stedet for "log ind igen". Vi bruger derfor det
 *    nye, som svarer 401, og behandler en tom reol som mistaenkelig.
 *  - Ved almindeligt login findes der INGEN refresh-token. Naar JWT'en
 *    udloeber, er eneste vej et nyt login - derfor gemmes kodeordet (krypteret).
 *  - Reolen er et FULDT oejebliksbillede med `state` og `stateUpdateTime` pr.
 *    bog. Derfor mister vi intet, selv om synken har vaeret nede i dagevis:
 *    vi filtrerer paa tidsstemplet, ikke paa "hvad er nyt siden sidste kald".
 */

const crypto = require('node:crypto');

// Storytels login krypterer kodeordet med en fast, offentligt kendt noegle.
// Det er obfuskering, ikke sikkerhed - fortroligheden ligger i https.
const ST_KEY = 'VQZBJ6TD8M9WBUWT';
const ST_IV = 'joiwef08u23j341a';
const LOGIN_URL = 'https://www.storytel.com/api/login.action';
const REOL_URL = 'https://api.storytel.net/libraries/bookshelf';
const TIMEOUT = 20000;

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9æøå]/g, '');
const efternavn = a => { const p = String(a || '').trim().split(/\s+/); return p.length ? p[p.length - 1].toLowerCase() : ''; };

function krypterKodeord(kodeord) {
  const c = crypto.createCipheriv('aes-128-cbc', ST_KEY, ST_IV);
  return (c.update(String(kodeord), 'utf8', 'hex') + c.final('hex')).toUpperCase();
}

/** Laeser udloebstiden ud af en JWT uden at verificere den (kun til visning). */
function jwtUdloeb(jwt) {
  try {
    const del = String(jwt).split('.');
    if (del.length < 2) return null;
    const p = JSON.parse(Buffer.from(del[1], 'base64url').toString('utf8'));
    return p && p.exp ? new Date(p.exp * 1000).toISOString() : null;
  } catch (e) { return null; }
}

function opret(srv) {
  /* --------------------------------------------------------- hemmeligheder */
  // Kodeordet ligger krypteret i settings (AES-256-GCM, noegle udledt af
  // serverens egen hemmelighed) og forlader ALDRIG serveren.
  const noegle = () => crypto.createHash('sha256').update('mofibo:' + srv.serverSecret()).digest();
  function krypter(tekst) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', noegle(), iv);
    const ud = Buffer.concat([c.update(String(tekst), 'utf8'), c.final()]);
    return [iv.toString('hex'), c.getAuthTag().toString('hex'), ud.toString('hex')].join(':');
  }
  function dekrypter(gemt) {
    const [iv, tag, data] = String(gemt || '').split(':');
    if (!iv || !tag || !data) return '';
    const d = crypto.createDecipheriv('aes-256-gcm', noegle(), Buffer.from(iv, 'hex'));
    d.setAuthTag(Buffer.from(tag, 'hex'));
    return Buffer.concat([d.update(Buffer.from(data, 'hex')), d.final()]).toString('utf8');
  }

  /* ---------------------------------------------------------------- API */
  async function login(email, kodeord) {
    const u = new URL(LOGIN_URL);
    u.searchParams.set('m', '1');
    u.searchParams.set('uid', String(email).trim());
    u.searchParams.set('pwd', krypterKodeord(kodeord));
    const r = await fetch(u, { signal: AbortSignal.timeout(TIMEOUT), headers: { Accept: 'application/json' } });
    if (r.status === 401) throw Object.assign(new Error('Mofibo afviste e-mail eller kodeord'), { kode: 'login' });
    if (!r.ok) throw Object.assign(new Error('Mofibo svarede ' + r.status + ' ved login'), { kode: 'net' });
    const d = await r.json();
    const jwt = d && d.accountInfo && d.accountInfo.jwt;
    if (!jwt) throw Object.assign(new Error('Mofibo returnerede ingen adgangsnøgle (bruger du Google/Apple-login?)'), { kode: 'login' });
    return { jwt, udloeb: jwtUdloeb(jwt) };
  }

  /** Hele reolen som et oejebliksbillede: [{id, titel, forfattere, cover, state, tid}] */
  async function hentReol(jwt) {
    const r = await fetch(REOL_URL, {
      method: 'POST', signal: AbortSignal.timeout(TIMEOUT),
      headers: { Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/x-www-form-urlencoded', Accept: '*/*' },
      body: 'items='
    });
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error('Mofibo-adgangen er udløbet – forbind igen'), { kode: 'auth' });
    if (!r.ok) throw Object.assign(new Error('Mofibo svarede ' + r.status), { kode: 'net' });
    const d = await r.json();
    const items = (d && d.items) || {};
    return Object.values(items).map(x => x && x.model).filter(Boolean).map(m => {
      const fmt = Array.isArray(m.formats) ? m.formats : [];
      const cover = (fmt.find(f => f.cover && f.cover.url) || {}).cover;
      // stateUpdateTime er tidspunktet, bogen skiftede status (= blev faerdig).
      // Findes den ikke, falder vi tilbage paa laeseposition-stemplet.
      const tid = m.stateUpdateTime || (fmt.map(f => f.position && f.position.updatedTime).filter(Boolean).sort().pop() || null);
      return {
        id: String(m.id),
        titel: String(m.title || '').trim(),
        forfattere: (Array.isArray(m.authors) ? m.authors : []).map(a => a && a.name).filter(Boolean),
        cover: cover ? String(cover.url) : '',
        state: String(m.state || ''),
        tid: tid ? String(tid) : null
      };
    });
  }

  /* -------------------------------------------------------------- synk */
  const indst = () => {
    let seen = {};
    try { seen = JSON.parse(srv.setting('mofibo_seen', '{}')) || {}; } catch (e) {}
    return {
      email: srv.setting('mofibo_email', ''),
      kodeord: srv.setting('mofibo_pass', ''),
      tilstand: srv.setting('mofibo_mode', 'nye') === 'fuld' ? 'fuld' : 'nye',
      siden: srv.setting('mofibo_since', ''),
      sidst: srv.setting('mofibo_last', ''),
      resultat: srv.setting('mofibo_result', ''),
      udloeb: srv.setting('mofibo_exp', ''),
      seen
    };
  };

  function status(userId) {
    const i = indst();
    return {
      forbundet: !!(i.email && i.kodeord),
      email: i.email,
      tilstand: i.tilstand,
      siden: i.siden,
      sidsteSynk: i.sidst,
      sidsteResultat: i.resultat,
      tokenUdloeb: i.udloeb,
      antalHentet: Object.keys(i.seen).length
    };
  }

  async function forbind(userId, email, kodeord, tilstand) {
    const { udloeb } = await login(email, kodeord);   // fejler her, hvis oplysningerne er forkerte
    srv.setSetting('mofibo_email', String(email).trim());
    srv.setSetting('mofibo_pass', krypter(kodeord));
    srv.setSetting('mofibo_mode', tilstand === 'fuld' ? 'fuld' : 'nye');
    // "Kun nye" maaler fra NU. Ved fuld synk er der ingen graense.
    srv.setSetting('mofibo_since', new Date().toISOString());
    srv.setSetting('mofibo_exp', udloeb || '');
    srv.setSetting('mofibo_result', '');
    return status(userId);
  }

  function afbryd(userId) {
    for (const k of ['mofibo_email', 'mofibo_pass', 'mofibo_mode', 'mofibo_since', 'mofibo_last', 'mofibo_result', 'mofibo_exp', 'mofibo_seen']) {
      srv.setSetting(k, '');
    }
    return status(userId);
  }

  /**
   * Henter faerdiglaeste boeger ind. `fuld` overstyrer tilstanden for ét kald.
   * Returnerer {tilfoejet, opdateret, sprunget, ialt}.
   */
  async function synk(userId, fuld) {
    const i = indst();
    if (!i.email || !i.kodeord) throw Object.assign(new Error('Mofibo er ikke forbundet'), { kode: 'ikke' });
    const { jwt, udloeb } = await login(i.email, dekrypter(i.kodeord));
    if (udloeb) srv.setSetting('mofibo_exp', udloeb);
    const reol = await hentReol(jwt);

    // En helt tom reol er mistaenkelig, naar vi tidligere har hentet boeger:
    // det er saadan et tavst API-skift ville se ud.
    if (!reol.length && Object.keys(i.seen).length) {
      throw Object.assign(new Error('Mofibo returnerede en tom reol – integrationen kan være ændret. Intet blev rørt.'), { kode: 'tom' });
    }

    const graense = (fuld === true || (fuld === undefined && i.tilstand === 'fuld')) ? null : (i.siden || null);
    const faerdige = reol.filter(b => b.state === 'CONSUMED' && b.titel)
      .filter(b => !graense || (b.tid && b.tid > graense));

    const mine = srv.booksFor(userId);
    const seen = Object.assign({}, i.seen);
    let tilfoejet = 0, opdateret = 0, sprunget = 0;

    for (const m of faerdige) {
      const aar = m.tid ? new Date(m.tid).getFullYear() : null;
      // Har vi hentet den foer, respekterer vi brugerens senere sletning.
      if (seen[m.id]) { sprunget++; continue; }
      const findes = mine.find(b => norm(b.title) === norm(m.titel)
        && (!m.forfattere.length || !(b.authors || []).length || efternavn((b.authors || [])[0]) === efternavn(m.forfattere[0])));
      if (findes) {
        // Bogen staar der allerede - markér den blot som laest.
        if (!findes.read) {
          srv.saveBook(userId, Object.assign({}, findes, {
            read: true, readYear: findes.readYear || aar
          }));
          opdateret++;
        } else sprunget++;
      } else {
        srv.saveBook(userId, {
          id: srv.nytId(), isbn: '', title: m.titel, authors: m.forfattere.slice(0, 10),
          cover: /^https:/.test(m.cover) ? m.cover : '', series: '', seriesNo: '',
          edition: '', printing: '', owned: false, format: 'paperback',
          read: true, readYear: aar, wishlist: false, loaned: false, loanedTo: '', loanedAt: null,
          rating: 0, notes: 'Lyttet/læst på Mofibo', addedAt: new Date().toISOString(), deleted: false
        });
        tilfoejet++;
      }
      seen[m.id] = 1;
    }

    srv.setSetting('mofibo_seen', JSON.stringify(seen));
    srv.setSetting('mofibo_last', new Date().toISOString());
    const res = { tilfoejet, opdateret, sprunget, faerdigeIReolen: faerdige.length, ialt: reol.length };
    srv.setSetting('mofibo_result', JSON.stringify(res));
    return res;
  }

  return { status, forbind, afbryd, synk, _login: login, _hentReol: hentReol, _krypter: krypter, _dekrypter: dekrypter, _jwtUdloeb: jwtUdloeb };
}

module.exports = { opret, krypterKodeord, jwtUdloeb };
