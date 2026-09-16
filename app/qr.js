'use strict';
/*
 * doda - QR-koder, haandskrevet uden pakker.
 *
 * Kun dét, en `otpauth://`-adresse har brug for: **byte-mode**, niveau **M**,
 * og de versioner, der raekker (1-10). Ingen kanji, ingen tal-optimering,
 * ingen struktureret sammenkaedning - alt det ville vaere kode, der aldrig
 * blev koert.
 *
 * Standarden er ISO/IEC 18004. De fire ting, det er let at faa galt:
 *
 *  - **Reed-Solomon over GF(256)** med polynomiet 0x11D. Faelden er, at
 *    generator-polynomiet skal bygges op grad for grad; skriver man
 *    koefficienterne af fra en tabel, opdager man foerst fejlen, naar en
 *    scanner siger nej.
 *  - **Data laegges i zigzag NEDEFRA og OP**, to soejler ad gangen, og
 *    soejle 6 (timing) springes helt over. Uden det springer alt én plads.
 *  - **Masken vaelges paa straf**, ikke frit. En daarlig maske giver flader,
 *    scanneren laeser som finder-moenstre.
 *  - **Format-informationen staar TO steder** og har sin egen BCH-kode. Er
 *    kun det ene sted rigtigt, laeser halvdelen af scannerne den fint - og
 *    resten slet ikke.
 */

/* ------------------------------------------------------------ GF(256) */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function tabeller() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;          // det primitive polynomium
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}());

const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Generator-polynomiet for `n` rettebytes - bygget op grad for grad. */
function generator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const ny = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      ny[j] ^= g[j];
      ny[j + 1] ^= gmul(g[j], EXP[i]);
    }
    g = ny;
  }
  return g;
}

/** Rettebytes til én blok. */
function rsRest(data, n) {
  const g = generator(n);
  const rest = new Array(n).fill(0);
  for (const b of data) {
    const faktor = b ^ rest[0];
    rest.shift();
    rest.push(0);
    for (let i = 0; i < n; i++) rest[i] ^= gmul(g[i + 1], faktor);
  }
  return rest;
}

/* ------------------------------------------------------- versionsdata */

/* Pr. version (1-10) ved niveau M: [rettebytes pr. blok, antal blokke i
   gruppe 1, databytes pr. blok i gruppe 1, blokke i gruppe 2, bytes i
   gruppe 2]. Tallene staar i standardens tabel 13-22. */
const M = {
  1: [10, 1, 16, 0, 0],
  2: [16, 1, 28, 0, 0],
  3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0],
  5: [24, 2, 43, 0, 0],
  6: [16, 4, 27, 0, 0],
  7: [18, 4, 31, 0, 0],
  8: [22, 2, 38, 2, 39],
  9: [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
};

/* Hvor justerings-moenstrene staar. Version 1 har ingen. */
const JUST = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

const kapacitet = (v) => {
  const [ec, b1, d1, b2, d2] = M[v];
  return b1 * d1 + b2 * d2;
};

/* --------------------------------------------------------- selve koden */

function lavQr(tekst) {
  const bytes = [...Buffer.from(String(tekst), 'utf8')];

  // Mindste version, teksten kan vaere i. 4 bit tilstand + 8/16 bit laengde.
  let v = 0;
  for (let i = 1; i <= 10; i++) {
    const laengdeBits = i < 10 ? 8 : 16;
    if (bytes.length + 2 + Math.ceil(laengdeBits / 8) <= kapacitet(i)) { v = i; break; }
  }
  if (!v) throw new Error('teksten er for lang til en QR-kode af denne stoerrelse');

  /* --- bitstreng --- */
  const bits = [];
  const put = (vaerdi, n) => { for (let i = n - 1; i >= 0; i--) bits.push((vaerdi >> i) & 1); };
  put(0b0100, 4);                                   // byte-tilstand
  put(bytes.length, v < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);

  const total = kapacitet(v) * 8;
  put(0, Math.min(4, total - bits.length));         // afslutter
  while (bits.length % 8) bits.push(0);
  // Polstring skifter mellem de to faste bytes - det er standardens krav,
  // ikke pynt: et fast moenster ville give flader, masken ikke kan bryde.
  const POLSTRING = [0xec, 0x11];
  for (let i = 0; bits.length < total; i++) put(POLSTRING[i % 2], 8);

  const dataBytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    dataBytes.push(b);
  }

  /* --- blokke og rettebytes --- */
  const [ec, b1, d1, b2, d2] = M[v];
  const blokke = [];
  let pos = 0;
  for (let i = 0; i < b1; i++) { blokke.push(dataBytes.slice(pos, pos + d1)); pos += d1; }
  for (let i = 0; i < b2; i++) { blokke.push(dataBytes.slice(pos, pos + d2)); pos += d2; }
  const rettelser = blokke.map((b) => rsRest(b, ec));

  // Blokkene FLETTES: byte 0 fra hver blok, saa byte 1 fra hver. Uden det
  // ville en ridse ramme én blok helt og gaa ud over rettelsen.
  const endelig = [];
  const maxData = Math.max(...blokke.map((b) => b.length));
  for (let i = 0; i < maxData; i++) for (const b of blokke) if (i < b.length) endelig.push(b[i]);
  for (let i = 0; i < ec; i++) for (const r of rettelser) endelig.push(r[i]);

  /* --- modulerne --- */
  const n = v * 4 + 17;
  const m = Array.from({ length: n }, () => new Array(n).fill(null));
  const saet = (r, c, val) => { if (r >= 0 && r < n && c >= 0 && c < n) m[r][c] = val; };

  // Finder-moenstre i tre hjoerner, med deres adskillere.
  for (const [fr, fc] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const kant = r === -1 || r === 7 || c === -1 || c === 7;
        const inde = r >= 0 && r <= 6 && c >= 0 && c <= 6
          && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        saet(fr + r, fc + c, kant ? 0 : (inde ? 1 : 0));
      }
    }
  }

  // Justerings-moenstre - men ikke oven i finder-moenstrene.
  const j = JUST[v];
  for (const r of j) {
    for (const c of j) {
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= n - 9) || (r >= n - 9 && c <= 8)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const kant = Math.max(Math.abs(dr), Math.abs(dc));
          saet(r + dr, c + dc, kant === 1 ? 0 : 1);
        }
      }
    }
  }

  // Timing: den stiplede linje, scanneren maaler modulstoerrelsen med.
  for (let i = 8; i < n - 8; i++) { saet(6, i, i % 2 === 0 ? 1 : 0); saet(i, 6, i % 2 === 0 ? 1 : 0); }
  saet(n - 8, 8, 1);                                  // altid soert

  // Pladsen til format-info reserveres, saa data ikke lander der.
  const reserveret = new Set();
  for (let i = 0; i < 9; i++) { reserveret.add(`8,${i}`); reserveret.add(`${i},8`); }
  for (let i = 0; i < 8; i++) { reserveret.add(`8,${n - 1 - i}`); reserveret.add(`${n - 1 - i},8`); }
  /*
   * Fra version 7 kraever standarden VERSIONSINFORMATION: 18 bit (6 bit
   * versionsnummer + 12 bit BCH) i to blokke paa 6x3. Uden dem giver enhver
   * scanner op - koden ser fin ud, men kan ikke laeses.
   *
   * Det er ikke noget, en afkoder, man selv har skrevet, opdager: springer
   * baade koderen og laeseren pladsen over paa samme maade, passer det hele
   * med sig selv. Fejlen findes kun med en RIGTIG scanner.
   */
  if (v >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let k = 0; k < 3; k++) {
        reserveret.add(`${i},${n - 11 + k}`);
        reserveret.add(`${n - 11 + k},${i}`);
      }
    }
  }

  /* --- data i zigzag, nedefra og op --- */
  let bit = 0;
  const alle = [];
  for (const b of endelig) for (let i = 7; i >= 0; i--) alle.push((b >> i) & 1);
  let opad = true;
  for (let c = n - 1; c > 0; c -= 2) {
    if (c === 6) c--;                                // soejle 6 er timing
    for (let i = 0; i < n; i++) {
      const r = opad ? n - 1 - i : i;
      for (const dc of [0, 1]) {
        const col = c - dc;
        if (m[r][col] !== null || reserveret.has(`${r},${col}`)) continue;
        m[r][col] = bit < alle.length ? alle[bit] : 0;
        bit++;
      }
    }
    opad = !opad;
  }

  /* --- maske: den med lavest straf --- */
  const MASKER = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  const erFast = (r, c) => {
    if (reserveret.has(`${r},${c}`)) return true;
    if (r === 6 || c === 6) return true;
    for (const [fr, fc] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
      if (r >= fr - 1 && r <= fr + 7 && c >= fc - 1 && c <= fc + 7) return true;
    }
    for (const rr of j) for (const cc of j) {
      if ((rr <= 8 && cc <= 8) || (rr <= 8 && cc >= n - 9) || (rr >= n - 9 && cc <= 8)) continue;
      if (Math.abs(r - rr) <= 2 && Math.abs(c - cc) <= 2) return true;
    }
    return false;
  };

  const straf = (g) => {
    let s = 0;
    // 1: fem eller flere ens i traek.
    for (let r = 0; r < n; r++) {
      for (const langs of [true, false]) {
        let sidst = -1;
        let antal = 0;
        for (let c = 0; c < n; c++) {
          const val = langs ? g[r][c] : g[c][r];
          if (val === sidst) antal++;
          else { sidst = val; antal = 1; }
          if (antal === 5) s += 3;
          else if (antal > 5) s += 1;
        }
      }
    }
    // 2: 2x2-flader.
    for (let r = 0; r < n - 1; r++) {
      for (let c = 0; c < n - 1; c++) {
        const a = g[r][c];
        if (a === g[r][c + 1] && a === g[r + 1][c] && a === g[r + 1][c + 1]) s += 3;
      }
    }
    // 3: moenstre, der ligner et finder-moenster.
    const M1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const M2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c + 10 < n; c++) {
        for (const [gr, gc] of [[r, c]]) {
          const vand = M1.every((x, i) => g[gr][gc + i] === x) || M2.every((x, i) => g[gr][gc + i] === x);
          if (vand) s += 40;
          const lod = M1.every((x, i) => g[gc + i][gr] === x) || M2.every((x, i) => g[gc + i][gr] === x);
          if (lod) s += 40;
        }
      }
    }
    // 4: skaevhed mellem sort og hvid.
    let sorte = 0;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (g[r][c]) sorte++;
    s += Math.floor(Math.abs((sorte * 100) / (n * n) - 50) / 5) * 10;
    return s;
  };

  let bedst = null;
  let bedstStraf = Infinity;
  let bedstMaske = 0;
  for (let mi = 0; mi < 8; mi++) {
    const g = m.map((raekke) => raekke.slice());
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!erFast(r, c) && MASKER[mi](r, c)) g[r][c] ^= 1;
      }
    }
    saetFormat(g, n, mi);
    saetVersion(g, n, v);
    const s = straf(g);
    if (s < bedstStraf) { bedstStraf = s; bedst = g; bedstMaske = mi; }
  }

  return { modules: bedst, size: n, version: v, mask: bedstMaske };
}

/**
 * Format-informationen: niveau M (0b00) + maske, med BCH(15,5) og en fast
 * maske ovenpaa. Den skrives TO steder - er kun det ene rigtigt, laeser
 * halvdelen af scannerne koden fint, og resten slet ikke.
 */
function saetFormat(g, n, maske) {
  const data = (0b00 << 3) | maske;
  let rest = data << 10;
  for (let i = 14; i >= 10; i--) if ((rest >> i) & 1) rest ^= 0b10100110111 << (i - 10);
  const bitsTal = ((data << 10) | rest) ^ 0b101010000010010;
  const b = (i) => (bitsTal >> i) & 1;

  /*
   * BIT 14 STAAR FOERST - ikke bit 0.
   *
   * Modulerne laeses i den raekkefoelge, standarden tegner dem, og den
   * foerste plads baerer den MEST betydende bit. Vender man den om, faar man
   * en kode, hvor alt andet er rigtigt: finder-moenstre, timing, data - men
   * ingen scanner kan laese den, for niveau og maske staar spejlvendt.
   *
   * Fundet ved at holde koden op mod en, macOS selv lavede: mine fire
   * niveauer gav 3/2/0/2, hvor standardens er 1/0/3/2.
   */
  for (let i = 0; i <= 5; i++) g[8][i] = b(14 - i);
  g[8][7] = b(8);
  g[8][8] = b(7);
  g[7][8] = b(6);
  for (let i = 9; i <= 14; i++) g[14 - i][8] = b(14 - i);

  /* Anden kopi: bits 0-6 nedad i soejle 8, bits 7-14 hen ad raekke 8.
     Deler man 7/8 forkert, bliver ÉN plads staaende tom - og en scanner, der
     laeser netop den kopi, giver op, mens en, der laeser den foerste, er
     ligeglad. Det var praecis den fejl her: hullet ved (8, n-8). */
  for (let i = 0; i <= 6; i++) g[n - 1 - i][8] = b(14 - i);
  for (let i = 7; i <= 14; i++) g[8][n - 15 + i] = b(14 - i);
  g[n - 8][8] = 1;
}

/**
 * Versionsinformationen (version >= 7): 6 bit version + 12 bit BCH(18,6).
 *
 * To blokke paa 6x3 - én over det nederste venstre finder-moenster, én til
 * venstre for det oeverste hoejre. Bit 0 er nederst til venstre i hver blok.
 */
function saetVersion(g, n, v) {
  if (v < 7) return;
  let rest = v << 12;
  for (let i = 17; i >= 12; i--) if ((rest >> i) & 1) rest ^= 0b1111100100101 << (i - 12);
  const bits = (v << 12) | rest;
  for (let i = 0; i < 18; i++) {
    const b = (bits >> i) & 1;
    const r = Math.floor(i / 3);
    const c = i % 3;
    g[r][n - 11 + c] = b;      // oeverst til hoejre
    g[n - 11 + c][r] = b;      // nederst til venstre
  }
}

/** QR-koden som SVG. `stille` er den hvide kant, scanneren kraever. */
function tilSvg(tekst, opt) {
  const o = opt || {};
  const { modules, size } = lavQr(tekst);
  const stille = o.quiet === undefined ? 4 : o.quiet;
  const hele = size + stille * 2;
  const sti = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) sti.push(`M${c + stille} ${r + stille}h1v1h-1z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${hele} ${hele}" `
    + `width="${o.px || 220}" height="${o.px || 220}" shape-rendering="crispEdges" role="img" `
    + `aria-label="QR code">`
    + `<rect width="${hele}" height="${hele}" fill="#fff"/>`
    + `<path d="${sti.join('')}" fill="#000"/></svg>`;
}

module.exports = { lavQr, tilSvg, generator, rsRest };
