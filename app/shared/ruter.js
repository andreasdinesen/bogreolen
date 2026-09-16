/* Adresser til siderne - én liste, to brugere (RUNE-ERFARINGER §9g).
 *
 * Browseren skriver stien i adresselinjen, saa /statistik og /bog/<id> kan
 * bogmaerkes, deles og laegges paa hjemmeskaermen. Serveren skal svare med
 * index.html paa PRAECIS de samme stier, ellers giver et genindlaes en 404.
 * To lister ville skride fra hinanden ved den foerste nye side, saa den bor her.
 * Frontenden er inline i index.html - serveren saetter denne fil ind i siden
 * (se serveIndex i server.js), saa der er ingen ekstra .js at cache-buste.
 *
 * Kun de kendte stier peger paa appen. En catch-all ville ogsaa svare paa
 * /libs/html5-qrcode.min.jss og /icon-192.pgn med HTML - og en manglende fil,
 * der svarer 200 med en side, er den slags fejl man leder efter i timevis.
 *
 * NB: filen indsaettes i et <script>-element og maa derfor aldrig indeholde
 * teksten "</" efterfulgt af "script".
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.bogreolRuter = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  /* [side-id (view-<id> i index.html), adresse, andre stavemaader der ogsaa skal virke] */
  const SIDER = [
    ['lib',   'bibliotek',      ['lib', 'library', 'boeger', 'reol', 'bogreol']],
    ['add',   'tilfoej',        ['add', 'ny', 'ny-bog', 'scan']],
    ['stats', 'statistik',      ['stats', 'statistics']],
    ['more',  'indstillinger',  ['more', 'mere', 'settings', 'konto', 'min-konto']],
    ['admin', 'administration', ['admin', 'brugere']]
  ];
  /* En enkelt bog: /bog/<id>. Id'et har serverens egen form (sanitizeBook). */
  const BOG = 'bog';
  const BOG_ID = /^[0-9a-f-]{8,64}$/i;

  /* Stien skal kunne skrives i haanden: /Statistik, /tilføj/ og /tilf%C3%B8j
   * skal ramme det samme. æøå foldes til ae/oe/aa - samme translit som
   * adresserne selv er skrevet i. */
  function nogle(sti) {
    let s = String(sti || '');
    try { s = decodeURIComponent(s); } catch (e) { /* ugyldig %-kode: brug raa */ }
    return s.toLowerCase()
      .replace(/æ/g, 'ae').replace(/ø/g, 'oe').replace(/å/g, 'aa')
      .replace(/^\/+/, '').replace(/\/+$/, '');
  }

  const OPSLAG = {};
  for (const [id, sti, alias] of SIDER) {
    OPSLAG[nogle(sti)] = id;
    for (const a of alias || []) OPSLAG[nogle(a)] = id;
  }

  /* /bog/<id> -> id (i den form, det staar i adressen), ellers null. */
  function bogForSti(sti) {
    const n = nogle(sti).split('/');
    return n.length === 2 && (n[0] === BOG || n[0] === 'book') && BOG_ID.test(n[1]) ? n[1] : null;
  }

  /* '/' er biblioteket; alt andet slaas op. /bog/<id> -> 'bog'. Ukendt -> null (serveren 404'er). */
  function sideForSti(sti) {
    const n = nogle(sti);
    if (n === '' || n === 'index.html') return 'lib';
    if (bogForSti(sti)) return BOG;
    return OPSLAG[n] || null;
  }

  function stiForSide(side, bogId) {
    if (side === BOG) return bogId && BOG_ID.test(bogId) ? '/' + BOG + '/' + bogId.toLowerCase() : null;
    for (const [id, sti] of SIDER) if (id === side) return '/' + sti;
    return null;
  }

  return { SIDER, BOG, sideForSti, stiForSide, bogForSti };
}));
