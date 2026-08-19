'use strict';
/*
 * Min Bogreol - manuelt opslag hos Bog & idé (bog-ide.dk).
 *
 * Bruges KUN naar brugeren selv trykker paa knappen for én bog. Det er med vilje
 * ikke en fast kilde i ISBN-kaeden: butikken er en Shopify-shop, og selv om
 * produktsiden har ordentlig schema.org-Book-JSON-LD, kan et temaskift aendre
 * vejen dertil. Naar det kun sker paa et klik, er en fejl synlig med det samme
 * i stedet for at goere en automatisk synk upaalidelig.
 *
 * To kald: soegesiden giver produktets handle, produktsiden giver JSON-LD'en
 * (navn, forfatter, isbn, cover, format, sider, udgivelsesaar).
 */

const BASE = 'https://www.bog-ide.dk';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const TIMEOUT = 15000;
const MAX_BYTES = 3e6;   // produktsiden er ~650 KB; et loft holder en overraskelse ude af hukommelsen

const cifre = s => String(s || '').replace(/[^0-9Xx]/g, '').toUpperCase();

/** Finder produktets handle i soegeresultatet (Shopify laegger det i sit analytics-blob). */
function findHandle(html) {
  const m = String(html).match(/\/products\/([a-z0-9][a-z0-9\-]{3,120})/i);
  return m ? m[1] : '';
}

/** Traekker schema.org-Book ud af produktsiden. Returnerer null, hvis den ikke er der. */
function parseBook(html) {
  const blokke = String(html).match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const b of blokke) {
    const raa = b.replace(/^[\s\S]*?>/, '').replace(/<\/script>$/i, '');
    let d;
    try { d = JSON.parse(raa.trim()); } catch (e) { continue; }
    for (const kandidat of (Array.isArray(d) ? d : [d, ...(d['@graph'] || [])])) {
      if (!kandidat || typeof kandidat !== 'object') continue;
      const t = kandidat['@type'];
      const typer = Array.isArray(t) ? t : [t];
      if (!typer.includes('Book')) continue;
      const navne = x => (Array.isArray(x) ? x : [x]).map(v => (v && typeof v === 'object' ? v.name : v)).filter(Boolean).map(String);
      const billede = Array.isArray(kandidat.image) ? kandidat.image[0] : kandidat.image;
      const fmt = String(kandidat.bookFormat || '').toLowerCase();
      return {
        title: String(kandidat.name || '').trim(),
        authors: navne(kandidat.author).slice(0, 10),
        isbn: cifre(kandidat.isbn || kandidat.gtin13),
        cover: billede ? String(billede).replace(/^\/\//, 'https://') : '',
        publisher: navne(kandidat.publisher)[0] || '',
        format: fmt.includes('hardcover') ? 'hardback' : (fmt.includes('paperback') ? 'paperback' : ''),
        pages: Number.isFinite(Number(kandidat.numberOfPages)) ? Number(kandidat.numberOfPages) : null,
        year: String(kandidat.datePublished || '').slice(0, 4) || ''
      };
    }
  }
  return null;
}

async function hentTekst(url, fetchFn) {
  const r = await (fetchFn || fetch)(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    signal: AbortSignal.timeout(TIMEOUT), redirect: 'follow'
  });
  // 429/503 er butikkens egen strubning - sig det som det er, saa brugeren proever igen
  // i stedet for at tro, at bogen ikke findes.
  if (r.status === 429 || r.status === 503) {
    throw Object.assign(new Error('Bog & idé er optaget lige nu – prøv igen om et øjeblik'), { kode: 'travl' });
  }
  if (!r.ok) throw Object.assign(new Error('Bog & idé svarede ' + r.status), { kode: 'net' });
  const t = await r.text();
  if (t.length > MAX_BYTES) throw Object.assign(new Error('Svaret fra Bog & idé var uventet stort'), { kode: 'net' });
  return t;
}

/** Slaar ét ISBN op. Returnerer {found:false} frem for at kaste, naar bogen bare ikke findes. */
async function hent(isbn, fetchFn) {
  const nr = cifre(isbn);
  if (nr.length !== 10 && nr.length !== 13) return { found: false, grund: 'ugyldigt ISBN' };
  const soeg = await hentTekst(`${BASE}/search?q=${encodeURIComponent(nr)}`, fetchFn);
  const handle = findHandle(soeg);
  if (!handle) return { found: false, grund: 'ingen træffer' };
  const side = await hentTekst(`${BASE}/products/${handle}`, fetchFn);
  const bog = parseBook(side);
  if (!bog || !bog.title) return { found: false, grund: 'kunne ikke læse produktsiden' };
  // Samme vaern som ved bibliotek.dk: soegningen kan ramme ved siden af, saa
  // butikkens eget ISBN skal stemme med det, vi bad om.
  if (bog.isbn && bog.isbn !== nr) return { found: false, grund: 'træfferen havde et andet ISBN' };
  return Object.assign({ found: true, url: `${BASE}/products/${handle}` }, bog);
}

module.exports = { hent, parseBook, findHandle };
