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
- ⌨️ Manuel indtastning og fritekst-søgning i bogdatabasen — skriver du et ISBN,
  hentes titel, forfatter, serie og cover, når du trykker »Gem«.
- 🖼️ Upload dit eget cover-billede, hvis bogen ikke findes i databaserne — det gemmes
  som en rigtig billedfil på serveren, så listen forbliver hurtig.
- 🔁 Retter du ISBN på en bog, henter appen ved næste »Gem« de oplysninger, der hører
  til det nye ISBN (titel, forfatter, serie og cover) — dine egne noter, vurdering og
  læst/ejet-status røres ikke, og du kan fortryde.
- ⬆️ »Tilbage til toppen«-knap i lange lister.
- 🔄 **Holder sig opdateret af sig selv**: når du åbner appen igen på telefonen,
  henter den nye bøger tilføjet på en anden enhed — og har serveren fået en ny
  version, kommer der en »Opdatér«-knap, så du slipper for at rydde cachen.
- 📷 Scan et ISBN direkte fra søgefeltet og find bogen i dit bibliotek.
- 🔍 **Berig biblioteket**: slå bøger uden ISBN op på titel + forfatter og få
  ISBN, cover og serie udfyldt automatisk (fx efter import fra regneark).
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
- 🔤 Bogstavs-oversigt i højre kant ved forfatter-/titelsortering — klik for at hoppe.
- 📱 Sidemenuen kan foldes væk (og er altid en overlay-menu på telefon og tablet).
- 🤖 **MCP-server til Claude** — lad Claude søge i, tilføje og opdatere dine bøger
  (se nedenfor).

## Adgang for Claude (MCP)

Under **⚙️ Mere → 🤖 Adgang for Claude (MCP)** kan du give Claude adgang til dit
bibliotek. Claude kan så fx svare på »har jeg læst noget af Jussi Adler-Olsen?«,
tilføje bøger du nævner (med opslag i bibliotek.dk), markere bøger som læst/udlånt,
og lave statistik. Der er to veje ind:

- **Claude Code / Claude Desktop** — opret en *adgangsnøgle* (vælg »kun læse« eller
  »læse og skrive«). Nøglen vises **én gang**; siden viser en færdig kommando:
  ```sh
  claude mcp add --transport http bogreol https://DIT-DOMÆNE/mcp --header "Authorization: Bearer br_…"
  ```
- **claude.ai i browseren** — tilføj en connector med adressen `https://DIT-DOMÆNE/mcp`.
  Claude sender dig til Bogreolens login/samtykkeside; når du har sagt ja, står appen
  under »Forbundne apps«, hvor du altid kan fjerne den igen. (Kræver https — brug dit
  domæne bag proxyen, ikke panelets IP:port.)

Nøgler og forbindelser gælder kun din egen bruger og kan tilbagekaldes med det samme.
En nøgle kan aldrig skifte kodeord, oprette nye nøgler eller administrere brugere —
det kræver login i appen. Sikkerhedshændelser (mislykkede logins) vises i panelets
sikkerhedshistorik.

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

### Opdatering

1. **Runes → Browse GitHub → Reload** henter den nye rune-definition.
2. På serveren: tryk **»Opdater Min Bogreol«** (runens egen knap) — den skifter
   app-filerne ud og lader databasen stå. (Update/Reinstall virker også.)

Samme knap bruges, hvis du skifter `NODE_IMAGE` for at få en nyere Node-version.

## Variabler

| Variabel | Betydning | Standard |
|---|---|---|
| `APP_NAME` | Appens navn i titel/login | `Min Bogreol` |
| `NODE_IMAGE` | Docker-image (Node-version) appen kører på — skift fx til `node:24.9.0-alpine` ved en CVE og tryk »Opdater« | `node:24-alpine` |

## Data og backup

Al data ligger i `bogreol.db` (SQLite) i serverens datamappe og følger med i
yggdrasils almindelige backups. Kodeord gemmes som scrypt-hash; passkeys
verificeres efter WebAuthn-standarden (ES256/RS256); sessions er HttpOnly-cookies.

## Passkeys bag reverse proxy

Appen læser `X-Forwarded-Proto` og `Host`, så bag fx Nginx Proxy Manager eller en
Cloudflare Tunnel binder passkeys sig korrekt til dit domæne. Husk at proxyen skal
pege på den port, yggdrasil har tildelt serveren.

## Byg runen selv

`runes/bogreol.yaml` er genereret af `build_rune.py`, som pakker `app/` (server,
MCP- og OAuth-modul, frontend, ikoner) som brotli-komprimeret tar i runens install-
og opdaterings-script og verificerer payloaden byte for byte:

```sh
python3 build_rune.py   # skriver runes/bogreol.yaml (kræver PyYAML og node)
```

Serveren er ren Node.js (>= 22) uden afhængigheder og bruger det indbyggede
`node:sqlite`-modul. MCP-serveren og OAuth 2.1-motoren er ligeledes håndskrevne
(JSON-RPC 2.0 over HTTP, PKCE, roterende refresh-tokens) — ingen pakker.
