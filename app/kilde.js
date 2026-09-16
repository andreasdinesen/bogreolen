/*
 * Min Bogreol henter sin egen kode.
 *
 * Til og med v27 BAR install-scriptet hele appen som brotli+base85 - 85.402
 * af de 131.072 tegn, Linux' MAX_ARG_STRLEN tillader, og index.html alene er
 * 141 KB og voksende. Et install-script, der HENTER koden, er konstant lille.
 *
 * Samtidig forsvinder et trin: `startup`-kommandoen koerer det her modul FOER
 * serveren, saa **en genstart er opdateringen**. Runen udgives kun, naar selve
 * runen aendrer sig. Portet fra Muldbog/Beanledger (2026-09-16); repoet er
 * OFFENTLIGT, saa hentningen kraever ingen legitimation (som kokkeri og doda).
 *
 * ── De tre regler ────────────────────────────────────────────────────────
 *
 * 1. **En fejl maa aldrig kunne forhindre serveren i at starte.** Alt herinde
 *    ender med exit 0. Kan GitHub ikke naas, koerer den kode, der ligger.
 * 2. **Der byttes ALDRIG halvt.** Der pakkes ud i en frisk mappe ved siden af,
 *    den tjekkes, og foerst derefter skiftes navnene. Mellem de to omdoebninger
 *    ligger app/ under `.bogreol-gammel`, og startup-kommandoen saetter den
 *    tilbage, hvis vi doer praecis der.
 * 3. **KODE_VERSION er en laas, ikke et oenske.** Staar der et tal, hentes
 *    praecis den tag - ogsaa selv om der findes en nyere.
 *
 * ── To ting, der er anderledes i Bogreolen ───────────────────────────────
 *
 *  - **Versionen staar som `const APP_VERSION = N;` i index.html.** Hele
 *    frontenden er inline; der findes intet `app.js?v=N` at genkende.
 *  - **Scanner-biblioteket ligger IKKE i git.** Install-scriptet henter
 *    html5-qrcode til app/public/libs/. Byttes hele app/ ud, forsvinder det -
 *    derfor tages libs/ med over fra den gamle app, FOER navnene skiftes.
 *    Kopien laves ind i den NYE mappe, som endnu ikke er i brug, saa en
 *    afbrudt kopi skader intet. Frontenden falder desuden selv tilbage til
 *    CDN, hvis filen mangler.
 */

'use strict';

const https = require('node:https');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EJER = 'andreasdinesen';
const REPO = 'bogreolen';

const APP = __dirname;                        // <rod>/app
const ROD = path.dirname(APP);                // runens arbejdsmappe
const MAERKE = path.join(APP, '.kode-version');
const NY = path.join(ROD, '.bogreol-ny');
const GAMMEL = path.join(ROD, '.bogreol-gammel');

/* En hentning, der haenger, ville haenge opstarten - og dermed appen. */
const TIMEOUT_MS = 20000;
/* GitHubs tag-liste er nogle faa kB. Et svar paa 4 MB er noget andet. */
const MAX_JSON = 4 * 1024 * 1024;
/* Arkivet er ~300 kB i dag. Loftet er en spaerre, ikke en forventning. */
const MAX_ARKIV = 64 * 1024 * 1024;

/* Foerste udgave der kan hente sin egen kode. Laases der laengere tilbage,
 * forsvinder kilde.js sammen med resten. */
const FOERSTE_SELVHENTENDE = 28;

function log(besked) { console.log(`[kode] ${besked}`); }

/* Advarsler skriver IKKE [fejl]: panelets watcher taeller [fejl]-linjer og
 * ville sende en notifikation, hver gang nettet var nede i et sekund. */
function advar(besked) { console.log(`[kode] advarsel: ${besked}`); }

/* ------------------------------------------------------------ hvad vil vi */

/**
 * Laeser panelets KODE_VERSION.
 *
 * TOMT betyder nyeste. Et felt, man SKAL udfylde for at faa almindelig
 * opfoersel, laeses som en indstilling, nogen har taget - og saa staar der en
 * laas, ingen har bedt om. »seneste«/»latest« accepteres ogsaa, fordi de er
 * det naturlige at skrive. Alt andet end et rent tal afvises HOEJLYDT frem
 * for at blive tolket: skriver man »v34«, skal man vide, det ikke virkede.
 */
function oensket(raa) {
  const t = String(raa === undefined ? (process.env.KODE_VERSION || '') : raa).trim();
  if (t === '' || /^(seneste|latest)$/i.test(t)) return { laast: false, tekst: 'seneste' };
  if (/^\d+$/.test(t)) return { laast: true, version: Number(t), tekst: t };
  return { laast: false, tekst: 'seneste', fejl: `KODE_VERSION »${t}« er hverken et tal eller »seneste«` };
}

/**
 * Hvilken udgave ligger der lige nu?
 *
 * Maerket skrives af den her fil. Findes det ikke, er app/ lagt af runens
 * install-script (eller en aeldre Bogreol) - og saa staar tallet i
 * index.html, hvor build'et stempler det. Uden det fallback ville foerste
 * genstart efter opgraderingen hente koden igen paa hver eneste server, ogsaa
 * naar den allerede var den rigtige.
 */
/** Versionen, som den staar i index.html - eller null. */
function stempel(html) {
  const m = /const APP_VERSION = (\d+);/.exec(String(html));
  return m ? Number(m[1]) : null;
}

function installeret(mappe = APP) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(mappe, '.kode-version'), 'utf8'));
    if (Number.isInteger(m.version)) return m;
  } catch { /* intet maerke - saa spoerger vi index.html */ }
  try {
    const v = stempel(fs.readFileSync(path.join(mappe, 'public', 'index.html'), 'utf8'));
    if (v !== null) return { version: v, oensket: null, hentet: null, kilde: 'install' };
  } catch { /* ingen app - saa er der intet at sammenligne med */ }
  return null;
}

/* ------------------------------------------------------------------- netto */

/**
 * GET med omdirigeringer.
 *
 * Repoet er offentligt, saa der sendes ingen legitimation - og en 404 paa en
 * tag-adresse betyder derfor én ting: taggen er ikke pushet.
 */
function hentSvar(url, forsoeg, ved) {
  return new Promise((ok, nej) => {
    const req = https.get(url, {
      headers: { 'user-agent': 'bogreol-opdatering', accept: '*/*' },
      timeout: TIMEOUT_MS,
    }, (res) => {
      const kode = res.statusCode;
      if (kode >= 300 && kode < 400 && res.headers.location) {
        res.resume();
        if (forsoeg <= 0) return nej(new Error(`${ved}: for mange omdirigeringer`));
        return ok(hentSvar(new URL(res.headers.location, url).toString(), forsoeg - 1, ved));
      }
      if (kode !== 200) {
        res.resume();
        return nej(new Error(kode === 404
          ? `${ved}: GitHub svarede 404 - er taggen pushet?`
          : `${ved}: GitHub svarede ${kode}`));
      }
      ok(res);
    });
    req.on('timeout', () => req.destroy(new Error(`${ved}: GitHub svarede ikke inden ${TIMEOUT_MS} ms`)));
    req.on('error', nej);
  });
}

async function hentJson(url, ved) {
  const res = await hentSvar(url, 3, ved);
  return new Promise((ok, nej) => {
    let tekst = '';
    res.setEncoding('utf8');
    res.on('data', (d) => {
      tekst += d;
      if (tekst.length > MAX_JSON) { res.destroy(); nej(new Error(`${ved}: svaret var for stort`)); }
    });
    res.on('end', () => {
      try { ok(JSON.parse(tekst)); } catch { nej(new Error(`${ved}: svaret var ikke JSON`)); }
    });
    res.on('error', nej);
  });
}

/**
 * Det hoejeste `vN` blandt repoets tags.
 *
 * GitHub sorterer tags ALFABETISK: »v9« staar efter »v80«. Tages `liste[0]`,
 * ruller hver server tilbage til v9 ved naeste genstart. Derfor regnes hele
 * listen igennem, og der bladres, til en side ikke er fuld.
 */
async function nyesteTag(hent = hentJson) {
  let bedst = 0;
  for (let side = 1; side <= 20; side += 1) {
    const url = `https://api.github.com/repos/${EJER}/${REPO}/tags?per_page=100&page=${side}`;
    const liste = await hent(url, 'tag-listen');
    if (!Array.isArray(liste) || liste.length === 0) break;
    for (const t of liste) {
      const m = /^v(\d+)$/.exec(String(t && t.name));
      if (m) bedst = Math.max(bedst, Number(m[1]));
    }
    if (liste.length < 100) break;
  }
  if (!bedst) throw new Error('tag-listen indeholdt ingen vN-tag - er der udgivet en tag endnu?');
  return bedst;
}

/* --------------------------------------------------------------- udpakning */

function ryd() {
  fs.rmSync(NY, { recursive: true, force: true });
  fs.rmSync(GAMMEL, { recursive: true, force: true });
}

/**
 * Henter og pakker `vN` ud i .bogreol-ny/ og returnerer stien til app-mappen.
 *
 * Der pakkes ud ved siden af app/ - ikke i /tmp. `mv` mellem to filsystemer er
 * en kopi, og en kopi kan afbrydes paa midten; et `rename` inden for samme
 * filsystem kan ikke.
 *
 * Repoet er offentligt, saa arkivet hentes direkte fra codeload.
 */
async function hentUdgave(version) {
  ryd();
  fs.mkdirSync(NY, { recursive: true });
  const arkiv = path.join(NY, 'kode.tar');
  const url = `https://codeload.github.com/${EJER}/${REPO}/tar.gz/refs/tags/v${version}`;
  const res = await hentSvar(url, 3, `arkivet v${version}`);
  await new Promise((ok, nej) => {
    let bytes = 0;
    const ud = fs.createWriteStream(arkiv);
    const pak = zlib.createGunzip();
    res.on('data', (d) => {
      bytes += d.length;
      if (bytes > MAX_ARKIV) { res.destroy(); nej(new Error('arkivet var for stort')); }
    });
    res.on('error', nej);
    pak.on('error', (e) => nej(new Error(`arkivet kunne ikke pakkes ud: ${e.message}`)));
    ud.on('error', nej);
    ud.on('finish', ok);
    res.pipe(pak).pipe(ud);
  });

  const r = spawnSync('tar', ['x', '-C', NY, '-f', arkiv], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tar fejlede: ${(r.stderr || '').trim().slice(0, 300)}`);
  fs.rmSync(arkiv, { force: true });

  /* Mappenavnet i et GitHub-arkiv er <ejer>-<repo>-<sha>. Det GAETTES ikke:
   * find den app-mappe, der findes. Arkivet begynder desuden med en
   * pax_global_header-post, som ikke er en mappe. */
  for (const navn of fs.readdirSync(NY)) {
    const kandidat = path.join(NY, navn, 'app');
    if (fs.existsSync(path.join(kandidat, 'server.js'))) return kandidat;
  }
  throw new Error('arkivet fra GitHub indeholder ingen app/server.js');
}

/**
 * Er det her en hel Bogreol - og er det den, vi bad om?
 *
 * Versionen laeses ud af det udpakkede index.html. Passer den ikke med taggen,
 * er koden ikke det, den udgiver sig for at vaere (en tag flyttet oven paa en
 * anden commit, fx), og saa byttes der IKKE. Hellere koere videre paa det
 * kendte end at starte noget, ingen kan navngive.
 */
function tjekTrae(mappe, version) {
  for (const kraevet of ['server.js', 'kilde.js', 'mcp.js', 'oauth.js',
    'bogide.js', 'mofibo.js', 'public/index.html']) {
    if (!fs.existsSync(path.join(mappe, ...kraevet.split('/')))) {
      throw new Error(`den hentede kode mangler ${kraevet}`);
    }
  }
  const v = stempel(fs.readFileSync(path.join(mappe, 'public', 'index.html'), 'utf8'));
  if (v === null) throw new Error('den hentede index.html har intet versionsstempel');
  if (v !== version) {
    throw new Error(`taggen v${version} indeholder kode stemplet v${v}`);
  }
}

/**
 * Byt app/ ud. To omdoebninger, ingen kopi.
 *
 * Doer processen mellem dem, ligger den gamle app under `.bogreol-gammel`,
 * og startup-kommandoen saetter den tilbage.
 */
/**
 * Tag scanner-biblioteket med fra den gamle app.
 *
 * libs/ ligger ikke i git - install-scriptet henter den. Kopien laves ind i
 * den NYE app, som endnu ikke er i brug; afbrydes den, er intet i drift roert.
 * Har den nye app allerede en libs/, vinder den. TOMME filer springes over:
 * en fejlet `wget -O` efterlod én i v27 og tidligere, og en tom .js indlaeses
 * uden fejl - saa ville frontenden aldrig falde tilbage til CDN.
 */
function bevarLibs(nyApp, gammelApp = APP) {
  const fra = path.join(gammelApp, 'public', 'libs');
  const til = path.join(nyApp, 'public', 'libs');
  if (!fs.existsSync(fra) || fs.existsSync(til)) return false;
  fs.cpSync(fra, til, {
    recursive: true,
    filter: (kilde) => { const s = fs.statSync(kilde); return s.isDirectory() || s.size > 0; },
  });
  return true;
}

function byt(nyApp, maerke) {
  if (bevarLibs(nyApp)) log('scanner-biblioteket er taget med over');
  fs.rmSync(GAMMEL, { recursive: true, force: true });
  if (fs.existsSync(APP)) fs.renameSync(APP, GAMMEL);
  fs.renameSync(nyApp, APP);
  fs.writeFileSync(path.join(APP, '.kode-version'), `${JSON.stringify(maerke, null, 2)}\n`);
  ryd();
}

/* ------------------------------------------------------------------ samlet */

async function opdater(env = process.env) {
  const vil = oensket(env.KODE_VERSION);
  if (vil.fejl) advar(`${vil.fejl} - bruger seneste`);
  const har = installeret();

  const maal = vil.laast ? vil.version : await nyesteTag();

  if (har && har.version === maal) {
    log(`v${maal} ligger allerede${vil.laast ? ' (laast)' : ''} - henter ikke`);
    /* Maerket opdateres alligevel: laasen kan vaere aendret i panelet, uden at
     * versionen er det, og saa skal appen kunne vise det rigtige. */
    try {
      fs.writeFileSync(MAERKE, `${JSON.stringify({
        version: maal, oensket: vil.tekst, hentet: (har && har.hentet) || null,
        kilde: (har && har.kilde) || 'install',
      }, null, 2)}\n`);
    } catch { /* et maerke er en bekvemmelighed, ikke en betingelse */ }
    return { version: maal, hentet: false };
  }

  if (maal < FOERSTE_SELVHENTENDE) {
    advar(`v${maal} er fra foer Min Bogreol kunne hente sin egen kode.`);
    advar('En genstart opdaterer ikke derfra - brug »Opdater Min Bogreol« i panelet for at komme videre.');
  }
  log(`henter v${maal}${har ? ` (har v${har.version})` : ''} ...`);
  const nyApp = await hentUdgave(maal);
  tjekTrae(nyApp, maal);
  byt(nyApp, {
    version: maal, oensket: vil.tekst, hentet: new Date().toISOString(), kilde: 'github',
  });
  log(`v${maal} er paa plads. Databasen i /data er uroert.`);
  return { version: maal, hentet: true };
}

async function main() {
  try {
    await opdater();
  } catch (err) {
    advar(`${err.message}`);
    advar('serveren starter paa den kode, der allerede ligger');
  } finally {
    try { ryd(); } catch { /* oprydning maa ikke kunne vaelte opstarten */ }
  }
  /* ALTID 0. Se regel 1 oeverst. */
  process.exit(0);
}

module.exports = { oensket, installeret, stempel, nyesteTag, tjekTrae, bevarLibs, opdater, MAERKE };

if (require.main === module) main();
