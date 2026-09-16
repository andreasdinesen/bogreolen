'use strict';
/*
 * doda - TOTP (RFC 6238) og genoprettelseskoder, haandskrevet uden pakker.
 *
 * Passkeys er staerkere end en engangskode - de kan ikke phishes. Men de
 * kraever https, og panelet naas paa IP:port over http (DESIGN §10), hvor
 * WebAuthn slet ikke findes. Kodeordet skal derfor altid virke, og saa er
 * kodeordet ALENE det svageste led. TOTP lukker netop dét hul: noget man ved
 * plus noget man har, ogsaa dér hvor en passkey ikke kan bruges.
 *
 * Tre ting er vaerd at vide, foer man laeser videre:
 *
 *  - **HMAC-SHA1, ikke SHA-256.** Det ser forkert ud i 2026, men det er dét,
 *    alle authenticator-apps regner med. Vaelger man SHA-256, virker koden
 *    ikke i Google Authenticator, og fejlen ligner en forkert hemmelighed.
 *  - **Et vindue paa hver side.** Ure driver, og en kode, der blev tastet
 *    lige foer et skift, skal stadig gaelde. Mere end ét vindue er at goere
 *    tyvens arbejde lettere for ingenting.
 *  - **Base32 UDEN polstring.** `otpauth://`-URI'en taaler ikke '=', og flere
 *    apps afviser hemmeligheden uden at sige hvorfor.
 */

const crypto = require('node:crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Bytes -> base32 uden polstring. */
function base32(buf) {
  let bits = 0;
  let vaerdi = 0;
  let ud = '';
  for (const b of buf) {
    vaerdi = (vaerdi << 8) | b;
    bits += 8;
    while (bits >= 5) {
      ud += B32[(vaerdi >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) ud += B32[(vaerdi << (5 - bits)) & 31];
  return ud;
}

/** base32 -> bytes. Mellemrum og smaa bogstaver taales: folk skriver af. */
function fraBase32(s) {
  const ren = String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let vaerdi = 0;
  const ud = [];
  for (const c of ren) {
    const i = B32.indexOf(c);
    if (i < 0) continue;
    vaerdi = (vaerdi << 5) | i;
    bits += 5;
    if (bits >= 8) {
      ud.push((vaerdi >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(ud);
}

/** En ny hemmelighed. 20 bytes er RFC'ens anbefaling for SHA-1. */
function nyHemmelighed() {
  return base32(crypto.randomBytes(20));
}

/**
 * Koden for ét tidsvindue.
 *
 * `counter` er sekunder siden epoch delt med 30. Big-endian i 8 bytes - og
 * ja, de fire foerste er nul frem til aar 2106; de SKAL med alligevel.
 */
function kodeFor(hemmelighed, counter) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 4294967296), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', fraBase32(hemmelighed)).update(buf).digest();
  // Dynamisk trunkering: de fire nederste bits udpeger, hvor koden begynder.
  const off = hmac[hmac.length - 1] & 0x0f;
  const tal = ((hmac[off] & 0x7f) << 24) | (hmac[off + 1] << 16)
    | (hmac[off + 2] << 8) | hmac[off + 3];
  return String(tal % 1000000).padStart(6, '0');
}

/**
 * Passer koden - nu, eller i vinduet foer eller efter?
 *
 * Sammenligningen er TIDSKONSTANT. En almindelig `===` paa strenge afsloerer
 * gennem svartiden, hvor mange cifre der var rigtige, og seks cifre er faa
 * nok til, at det betyder noget.
 *
 * Returnerer det counter-vindue, der passede, saa kalderen kan gemme det og
 * afvise den SAMME kode igen. Ellers kan en opsnappet kode bruges to gange
 * inden for det halve minut.
 */
function tjek(hemmelighed, kode, nu) {
  const ren = String(kode || '').replace(/\D/g, '');
  if (ren.length !== 6) return null;
  const counter = Math.floor((nu === undefined ? Date.now() : nu) / 1000 / 30);
  for (const d of [0, -1, 1]) {
    const forventet = kodeFor(hemmelighed, counter + d);
    const a = Buffer.from(forventet);
    const b = Buffer.from(ren);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return counter + d;
  }
  return null;
}

/**
 * Adressen, authenticator-appen skal have.
 *
 * Udstederen staar BAADE i stien og som parameter. Uden det foerste hedder
 * kontoen bare »andreas« i appens liste, og har man to servere, kan de ikke
 * kendes fra hinanden.
 */
function otpauth(hemmelighed, bruger, udsteder) {
  const u = encodeURIComponent(udsteder || 'doda');
  const b = encodeURIComponent(bruger || 'user');
  return `otpauth://totp/${u}:${b}?secret=${hemmelighed}&issuer=${u}&algorithm=SHA1&digits=6&period=30`;
}

/*
 * Genoprettelseskoder.
 *
 * Uden dem laaser en mistet telefon ejeren ude af sin EGEN server for altid -
 * der er ingen supportafdeling at ringe til. De gemmes hashet, praecis som et
 * kodeord: kan de laeses ud af databasen, er de ikke en noedudgang, men en
 * ekstra doer.
 */
function nyeKoder(antal = 10) {
  const koder = [];
  for (let i = 0; i < antal; i++) {
    // 10 tegn i grupper af fem. Ingen 0/O eller 1/I - de skal kunne skrives
    // af fra et stykke papir uden at gaette.
    const raa = crypto.randomBytes(10);
    let s = '';
    for (const b of raa) s += 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b & 31];
    koder.push(`${s.slice(0, 5)}-${s.slice(5, 10)}`);
  }
  return koder;
}

const hashKode = (k) => crypto.createHash('sha256')
  .update(String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, ''), 'utf8').digest('hex');

module.exports = { base32, fraBase32, nyHemmelighed, kodeFor, tjek, otpauth, nyeKoder, hashKode };
