# Min Bogreol som yggdrasil-rune

Personligt bogbibliotek pakket som en **rune** til
[yggdrasil](https://github.com/kristianwind/yggdrasil) — med **indbygget database**
(SQLite), **flere brugere**, **passkey-login** og **admin-styring**. Alt ligger i
runen; ingen eksterne databaser, ingen npm-pakker, ingen ekstra containere.

## Funktioner

- 📷 **Scan ISBN-stregkoden** bag på bogen — appen slår titel, forfatter, forside og
  serie op (Google Books + Open Library) og siger til med det samme, hvis du
  allerede har bogen.
- 🖼️ **Foto af forsiden** — tekstgenkendelse finder bogen ud fra titlen.
- 🇩🇰 Bogopslag via **bibliotek.dk** (danske bøger inkl. serier), Google Books og
  Open Library.
- ⌨️ Manuel indtastning og fritekst-søgning i bogdatabasen — indtaster du et
  ISBN, hentes cover og manglende oplysninger automatisk.
- 🖼️ Upload dit eget cover-billede, hvis bogen ikke findes i databaserne.
- 🔎 Hurtige filtre og sortering: forfatter, titel, serie, vurdering — ejet, læst,
  *læst men ikke købt*, ulæst, ønskeliste, hardback, paperback.
- 📖 Pr. bog: købt/ej, format (hardback/paperback), udgave og oplag, læst (med
  årstal), stjerner, noter.
- 🤝 Hold styr på udlån: skriv hvem bogen er lånt ud til — dato gemmes, og bogen
  får et »Udlånt«-badge og eget filter.
- 📚 **Serie-oversigt** — se hele serien, markér hvad du har, og få links til de
  bøger du mangler.
- 📈 Statistik: læste bøger pr. år, mest læste forfattere, formater.
- 💾 Eksport/import: JSON-backup med indlejrede cover-billeder (kan flyttes til
  et andet site) eller CSV til hurtig gennemgang i Excel — begge kan importeres
  igen.
- 🔤 Vælg selv, om titel eller forfatter står øverst i boglisten.
- 🎨 Lyst/mørkt tema — følger enheden automatisk, eller vælg selv under »Mere«.
- 🧹 Nulstil alt via panelets **Wipe**-knap: tømmer databasen (med automatisk
  backup først), så du kan starte forfra — fx efter en fejlimport.

## Brugere og login

- Brugernavn + kodeord (scrypt-hashet, brute force-beskyttet) **og passkeys**
  (WebAuthn — Face ID/fingeraftryk). Passkeys kræver at appen tilgås over **https**
  (kodeords-login virker også over http).
- **Den første bruger, der oprettes, bliver automatisk administrator.**
- Hver bruger har sit eget bibliotek.
- Admin-panel under **⚙️ Mere → 👑 Administration**: se alle brugere, giv nyt
  kodeord, gør til/fjern admin, slet brugere, og åbn/luk for nye registreringer.
  Den sidste administrator kan ikke slettes eller degraderes.

## Installation i yggdrasil

1. **Runes → Browse runes on GitHub**
   - Repository: `andreasdinesen/bogreolen`
   - Folder: `runes`
2. Vælg **Min Bogreol** og opret en server fra runen.
3. **Install** → **Start**.
4. Åbn den tildelte port i browseren og opret den første bruger (= administrator).

Alternativt: hent `runes/bogreol.yaml` og upload den under **Runes → Carve a rune**.

## Variabler

| Variabel | Betydning | Standard |
|---|---|---|
| `APP_NAME` | Appens navn i titel/login | `Min Bogreol` |

## Data og backup

Al data ligger i `bogreol.db` (SQLite) i serverens datamappe og følger med i
yggdrasils almindelige backups. Kodeord gemmes som scrypt-hash; passkeys
verificeres efter WebAuthn-standarden (ES256/RS256); sessions er HttpOnly-cookies.

## Passkeys bag reverse proxy

Appen læser `X-Forwarded-Proto` og `Host`, så bag fx Nginx Proxy Manager eller en
Cloudflare Tunnel binder passkeys sig korrekt til dit domæne. Husk at proxyen skal
pege på den port, yggdrasil har tildelt serveren.

## Byg runen selv

`runes/bogreol.yaml` er genereret af `build_rune.py`, som indlejrer `app/server.js`
og `app/public/index.html` i runens install-script:

```sh
python3 build_rune.py   # skriver runes/bogreol.yaml
```

Serveren er ren Node.js (>= 22) uden afhængigheder og bruger det indbyggede
`node:sqlite`-modul. Runtime-image: `node:24-alpine`.
