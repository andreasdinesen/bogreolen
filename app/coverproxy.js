'use strict';
/* Min Bogreol - billed-proxy til eksporten.
 *
 * Browseren kan ikke laese billeddata fra et fremmed domaene (canvas-taint), saa
 * serveren henter coveret og sender det videre. Det goer serveren til en klient,
 * der hopper derhen, hvor en URL peger - og derfor er der to vagter:
 *
 *  1. **Vaerten tjekkes ved HVERT hop, ikke kun det foerste.** `fetch` med
 *     `redirect: 'follow'` tjekkede kun den adresse, brugeren sendte; en 302 fra
 *     en tilladt vaert kunne sende serveren videre hvorhen som helst. Her foelges
 *     omdirigeringer i haanden (hoejst MAKS_HOP), og hver ny vaert skal staa paa
 *     listen.
 *  2. **Adressen, navnet slaar op til, maa ikke vaere privat.** Tjekket ligger i
 *     selve DNS-opslaget, som forbindelsen bruger - saa et navn, der skifter
 *     adresse mellem tjek og forbindelse (DNS-rebinding), ikke slipper igennem.
 *
 * Vaertslisten er MAALT (curl -sI, 2026-09-16), ikke gaettet:
 *   covers.openlibrary.org/b/id/…  -> 302 archive.org/download/…
 *                                   -> 302 ia<nr>.us.archive.org/view_archive.php?…
 *   books.google.com/books/content  -> 200 direkte
 *   fbiinfo-present.dbc.dk/images/… -> 200 direkte
 *   default-forsider.dbc.dk/large/… -> 200 direkte (bibliotek.dk's standardforsider)
 * archive.org-vaerterne er kun tilladt som MAAL for en omdirigering - archive.org
 * rummer alt muligt andet end forsider. */

const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');

const START = ['covers.openlibrary.org', 'books.google.com', 'fbiinfo-present.dbc.dk', 'default-forsider.dbc.dk'];
const KUN_SOM_MAAL = [/^archive\.org$/, /^ia\d+\.us\.archive\.org$/];
const MAKS_HOP = 3;
const MAKS_BYTES = 3000000;

const tilladtVaert = (vaert, hop) => START.includes(vaert) || (hop > 0 && KUN_SOM_MAAL.some(r => r.test(vaert)));

/* Loopback, private net, link-local (inkl. cloud-metadata 169.254.169.254),
 * CGNAT, multicast og reserverede. IPv4-mappede IPv6-adresser (::ffff:10.0.0.1)
 * rammes af de samme IPv4-regler. */
const PRIVAT = new net.BlockList();
for (const [a, n] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) PRIVAT.addSubnet(a, n, 'ipv4');
for (const [a, n] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) PRIVAT.addSubnet(a, n, 'ipv6');
function erPrivat(ip) {
  const v = net.isIP(String(ip || ''));
  if (!v) return true;                       // ukendt form = ikke tilladt
  return PRIVAT.check(ip, v === 6 ? 'ipv6' : 'ipv4');
}

/* DNS-opslag med vagt. Net-modulet kalder det baade med og uden {all: true}
 * (autoSelectFamily), saa begge svarformer skal kunne gives. `dns.lookup` slaas
 * op ved hvert kald, saa en proeve kan pege navnene et andet sted hen. */
function vagtOpslag(tilladAdresse) {
  return (vaert, o, cb) => {
    if (typeof o === 'function') { cb = o; o = {}; }
    const valg = typeof o === 'number' ? { family: o } : (o || {});
    dns.lookup(vaert, { all: true, family: valg.family || 0, hints: valg.hints || 0 }, (e, adr) => {
      if (e) return cb(e);
      if (!adr.length || adr.some(a => !tilladAdresse(a.address))) {
        const f = new Error('billed-kilden peger paa en privat adresse');
        f.code = 'PRIVAT_ADRESSE';
        return cb(f);
      }
      if (valg.all) return cb(null, adr);
      cb(null, adr[0].address, adr[0].family);
    });
  };
}

/* Ét hop. Omdirigeringer foelges IKKE her - de returneres til loekken.
 * `agent: false`: en genbrugt keep-alive-forbindelse springer DNS-opslaget over -
 * og dermed vagten. Hvert hop faar sin egen forbindelse. */
function hentEt(url, opslag, signal) {
  return new Promise(resolve => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(url, { agent: false, lookup: opslag, signal, headers: { 'user-agent': 'MinBogreol-cover', accept: 'image/*' } }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400) {
        r.resume();
        return resolve({ status: r.statusCode, location: r.headers.location || '' });
      }
      const ct = String(r.headers['content-type'] || '');
      if (r.statusCode !== 200 || !ct.startsWith('image/')) { r.resume(); return resolve({ fejl: 'Intet billede', kode: 404 }); }
      if (Number(r.headers['content-length']) > MAKS_BYTES) { r.destroy(); return resolve({ fejl: 'Billedet er for stort', kode: 413 }); }
      const dele = [];
      let n = 0;
      r.on('data', d => {
        n += d.length;
        if (n > MAKS_BYTES) { r.destroy(); resolve({ fejl: 'Billedet er for stort', kode: 413 }); return; }
        dele.push(d);
      });
      r.on('end', () => resolve({ status: 200, type: ct, data: Buffer.concat(dele) }));
      r.on('error', () => resolve({ fejl: 'Kunne ikke hente billedet', kode: 502 }));
      // Afbrudt midt i kroppen (timeout): 'end' kommer aldrig. Et senere resolve er uden virkning.
      r.on('close', () => resolve({ fejl: 'Kunne ikke hente billedet', kode: 502 }));
    });
    req.on('error', e => resolve(e.code === 'PRIVAT_ADRESSE'
      ? { fejl: 'Billed-kilden peger på en privat adresse', kode: 403 }
      : { fejl: 'Kunne ikke hente billedet', kode: 502 }));
  });
}

/* Henter et cover. Svarer { type, data } eller { fejl, kode } - aldrig en undtagelse.
 * `opt.tilladAdresse` findes til proeverne (en attrap-server bor paa 127.0.0.1). */
async function hent(raa, opt) {
  const o = opt || {};
  const opslag = vagtOpslag(o.tilladAdresse || (ip => !erPrivat(ip)));
  const signal = AbortSignal.timeout(o.timeout || 10000);
  let url;
  try { url = new URL(String(raa || '')); } catch (e) { return { fejl: 'Ugyldig URL', kode: 400 }; }
  for (let hop = 0; ; hop++) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return { fejl: 'Ugyldig URL', kode: 400 };
    if (url.username || url.password) return { fejl: 'Ugyldig URL', kode: 400 };
    if (!tilladtVaert(url.hostname, hop)) {
      return hop === 0
        ? { fejl: 'Ukendt billed-kilde', kode: 403 }
        : { fejl: 'Billed-kilden omdirigerer til en ukendt vært', kode: 403 };
    }
    const r = await hentEt(url, opslag, signal);
    if (r.fejl) return r;
    if (r.status !== 200) {
      if (!r.location) return { fejl: 'Intet billede', kode: 404 };
      if (hop >= MAKS_HOP) return { fejl: 'For mange omdirigeringer', kode: 502 };
      try { url = new URL(r.location, url); } catch (e) { return { fejl: 'Ugyldig omdirigering', kode: 502 }; }
      continue;
    }
    return { type: r.type, data: r.data };
  }
}

module.exports = { hent, erPrivat, tilladtVaert, START, MAKS_HOP };
