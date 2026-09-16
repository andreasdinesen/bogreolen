#!/usr/bin/env python3
"""Byg bogreol.yaml - en Yggdrasil Panel-rune, der HENTER appen fra GitHub.

Til og med v27 bar runen hele appen som brotli+base85 i install- og
update-scriptet (85.402 af de 131.072 tegn, Linux' MAX_ARG_STRLEN tillader).
Fra v28 er runen en STARTSNOR: den henter koden fra taggen v<RUNE_VERSION>,
og app/kilde.js henter derefter selv nyeste udgave ved hver opstart. Samme
model som kokkeri og doda; repoet er offentligt, saa der kraeves intet token.
"""
import glob, os, re, subprocess, sys

def read(p):
    with open(p, encoding='utf-8') as f:
        return f.read()

server_js = read('app/server.js')
index_html = read('app/public/index.html')
kilde_js = read('app/kilde.js')

# Versionen bor ÉT sted: const APP_VERSION i index.html. kilde.js laeser
# ogsaa det stempel for at afgoere, hvilken udgave der ligger.
m = re.search(r'const APP_VERSION = (\d+);', index_html)
if not m:
    sys.exit('FEJL: APP_VERSION ikke fundet i index.html')
app_version = m.group(1)

# Runen er en STARTSNOR, ikke appen. Den bumpes KUN, naar YAML'en selv aendrer
# sig - ikke ved hver app-udgivelse. Gjorde den det, ville hver udgivelse kraeve
# et panel-trin igen, og saa var hele pointen tabt.
# Tallet skal pege paa en tag, der ER pushet: install-scriptet henter praecis
# den, og derfra opdaterer serveren sig selv ved genstart.
RUNE_VERSION = 28
assert RUNE_VERSION <= int(app_version), (
    f'FEJL: RUNE_VERSION ({RUNE_VERSION}) er nyere end APP_VERSION ({app_version}) - '
    'startsnoren ville pege paa en tag, der ikke findes.')

# --- serverens moduler: skal kunne parses, og alt de require'r skal findes ---
_moduler = sorted(glob.glob('app/*.js')) + sorted(glob.glob('app/shared/*.js'))
for _f in _moduler:
    subprocess.run(['node', '--check', _f], check=True)
_krav = set()
for _f in _moduler:
    for _r in re.findall(r"require\(['\"](\./[^'\"]+)['\"]\)", read(_f)):
        _p = os.path.normpath(os.path.join(os.path.dirname(_f), _r))
        if not _p.endswith('.js'):
            _p += '.js'
        _krav.add(_p)
_mangler = sorted(x for x in _krav if not os.path.exists(x))
if _mangler:
    sys.exit(f'FEJL: disse require-filer findes ikke: {_mangler}')

# --- sikkerhedstjek ---
for name in _moduler + ['app/public/index.html']:
    txt = read(name)
    hits = set(re.findall(r'\{\{[A-Z_]+\}\}', txt))
    if hits:
        sys.exit(f'FEJL: {name} indeholder skabelon-kollisioner: {hits}')
    if 'YGG_PAYLOAD_EOF' in txt:
        sys.exit(f'FEJL: {name} indeholder heredoc-markøren YGG_PAYLOAD_EOF')

# --- det, der hentes, er det, der er COMMITTET ---
#
# Runen henter hele app/ fra en tag. En require-fil, der findes paa disken men
# aldrig blev committet, virker lokalt og doer med MODULE_NOT_FOUND i panelet.
_sporet = set(subprocess.run(['git', 'ls-files', 'app'], capture_output=True, text=True,
                             check=True).stdout.split())
_krav_alle = _krav | {'app/kilde.js', 'app/server.js', 'app/public/index.html',
                      'app/public/icon-192.png', 'app/public/icon-512.png'}
_usporet = sorted(p for p in _krav_alle if p not in _sporet)
_aendret = subprocess.run(['git', 'status', '--porcelain', '--', 'app'],
                          capture_output=True, text=True, check=True).stdout.strip()

# ------------------------------------------------------------------ startsnor
#
# Repoet er offentligt: arkivet hentes direkte fra codeload, uden legitimation.
# En 404 betyder derfor én ting - taggen er ikke pushet.

HENTER_JS = (
    'const https=require("https"),zlib=require("zlib");'
    'const U="https://codeload.github.com/andreasdinesen/bogreolen/tar.gz/refs/tags/v%d";'
    'function d(m){console.error("[fejl] "+m);'
    'console.error("En 404 betyder, at taggen ikke er pushet.");process.exit(1);}'
    'function hent(u,n){https.get(u,{headers:{"user-agent":"bogreol-installer"}},(r)=>{'
    'if(r.statusCode>=300&&r.statusCode<400&&r.headers.location){'
    'if(n<=0)return d("for mange omdirigeringer");r.resume();'
    'return hent(new URL(r.headers.location,u).toString(),n-1);}'
    'if(r.statusCode!==200)return d("GitHub svarede "+r.statusCode);'
    'const g=zlib.createGunzip();'
    'g.on("error",(e)=>d("arkivet kunne ikke pakkes ud: "+e.message));'
    'r.pipe(g).pipe(process.stdout);}).on("error",(e)=>d("kunne ikke naa GitHub: "+e.message));}'
    'hent(U,3);'
) % RUNE_VERSION
# Henteren staar i en 'single quoted' sh-streng.
assert "'" not in HENTER_JS, 'henteren maa ikke indeholde apostroffer'

QR_URL = 'https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js'

# ---------------------------------------------------------- hent og byt
#
# Baade install og opdater skal hente app-koden og saette den paa plads. Samme
# fremgangsmaade som i app/kilde.js: pak ud VED SIDEN AF app/, flyt den gamle
# app vaek (slet den ikke), og flyt saa den nye ind. To `rename` inden for
# samme filsystem - aldrig en kopi, der kan afbrydes, og aldrig et sekund uden
# app/ (og dermed uden kilde.js til at redde sig selv).
#
# Scanner-biblioteket ligger ikke i git. Det tages med fra den gamle app, og
# hentes kun, hvis det mangler. `wget -O` efterlader en TOM fil, naar hentningen
# fejler - og en tom .js indlaeses uden fejl, saa frontenden aldrig falder
# tilbage til CDN. Derfor hentes der til en midlertidig fil, der kun flyttes
# ind, naar den har indhold.

def hent_og_byt(henter):
    return f"""rm -rf .bogreol-ny
mkdir -p .bogreol-ny
node -e '{henter}' > .bogreol-ny/app.tar
tar x -C .bogreol-ny -f .bogreol-ny/app.tar
rm -f .bogreol-ny/app.tar

# Mappenavnet i et GitHub-arkiv er <repo>-<ref uden v>, og arkivet begynder med
# en pax_global_header-post. Ingen af delene gaettes: find den app-mappe, der FINDES.
NY=$(find .bogreol-ny -maxdepth 2 -type d -name app | head -n 1)
if [ -z "$NY" ] || [ ! -f "$NY/server.js" ]; then
  echo "[fejl] arkivet fra GitHub indeholder ingen app/server.js"
  exit 1
fi

mkdir -p "$NY/public/libs"
if [ -s app/public/libs/html5-qrcode.min.js ]; then
  cp app/public/libs/html5-qrcode.min.js "$NY/public/libs/"
elif wget -q -O "$NY/public/libs/qr.hent" {QR_URL} && [ -s "$NY/public/libs/qr.hent" ]; then
  mv "$NY/public/libs/qr.hent" "$NY/public/libs/html5-qrcode.min.js"
else
  rm -f "$NY/public/libs/qr.hent"
  echo "advarsel: kunne ikke hente scanner-biblioteket nu - appen bruger CDN i stedet"
fi

# Foerst HER er vi sikre paa, at der ligger en ny app at saette ind.
# .bogreol-gammel kan indeholde en redning fra en afbrudt udskiftning, og den
# maa ikke smides vaek, mens hentningen stadig kan fejle.
rm -rf .bogreol-gammel
if [ -d app ]; then mv app .bogreol-gammel; fi
mv "$NY" app
rm -rf .bogreol-ny .bogreol-gammel"""

install_script = f"""set -eu
echo "Installerer Min Bogreol (startsnor v{RUNE_VERSION}) ..."
echo "Node: $(node --version)"

echo "Henter app-koden fra GitHub ..."
{hent_og_byt(HENTER_JS)}

echo "Klar. Start serveren i panelet - den henter selv nyeste udgave"
echo "(eller den, KODE_VERSION laaser til), foer den starter."
"""

def indent(text, spaces):
    pad = ' ' * spaces
    return '\n'.join(pad + line if line.strip() else '' for line in text.split('\n'))

# Opdater-knappen skal bruge kilde.js, hvis den findes. Ellers ville den hente
# startsnorens tag oven i en nyere app - en NEDGRADERING, ingen bad om.
update_script = f"""set -eu
echo "Opdaterer Min Bogreol ..."
echo "Node: $(node --version)"

# Redningen, ordret som i startup. Knappen koerer uden om opstarten, saa den
# skal kunne det samme: ligger den gamle app under .bogreol-gammel efter en
# afbrudt udskiftning, skal den tilbage, FOER vi roerer noget som helst.
if [ ! -f app/server.js ] && [ -f .bogreol-gammel/server.js ]; then
  rm -rf app
  mv .bogreol-gammel app
  echo "[kode] app/ sat tilbage efter en afbrudt udskiftning"
fi

# Knappen kan trykkes to gange. `mkdir` er atomisk paa alle filsystemer, hvor
# `[ -d ]` efterfulgt af `mkdir` har et hul imellem sig. Laasen ligger om HELE
# scriptet - ogsaa kilde.js-grenen, som er den almindelige vej.
if ! mkdir .bogreol-laas 2>/dev/null; then
  echo "[fejl] en anden opdatering er allerede i gang."
  echo "Vent til den er faerdig, eller genstart Min Bogreol og proev igen."
  exit 1
fi
# En fejlet hentning er den ALMINDELIGE fejl. En laas, der overlever den, goer
# knappen doed for altid. En strandet laas ryddes af startup.
trap 'rm -rf .bogreol-laas .bogreol-ny' EXIT INT TERM

K="{{{{KODE_VERSION}}}}"
case "$K" in
  '') : ;;
  seneste|latest|[0-9]*) : ;;
  *) K="${{KODE_VERSION:-}}" ;;
esac

if [ -f app/kilde.js ]; then
  echo "Bruger appens egen opdatering (app/kilde.js)."
  KODE_VERSION="$K" node app/kilde.js
else
  echo "Ingen app/kilde.js - henter startsnorens udgave v{RUNE_VERSION}."
{indent(hent_og_byt(HENTER_JS), 2)}
fi

echo "Min Bogreol er opdateret. Databasen er uroert."

# Panelets app-update svarer 202 og skifter FILER. Den genstarter ikke
# serveren. Beskeden er den eneste vagt mod det, saa den staar sidst.
echo ""
echo "============================================"
echo "  GENSTART MIN BOGREOL NU."
echo "  Filerne er skiftet ud, men serveren koerer"
echo "  stadig den gamle kode, indtil den genstartes."
echo "============================================"
"""

rune = f"""# Min Bogreol - personligt bogbibliotek som Yggdrasil-rune
# Alt (app + SQLite-database) ligger i serverens egen datamappe.
gameskill:
  id: bogreol
  name: "Min Bogreol"
  category: "Apps"
  description: "Personligt bogbibliotek: scan ISBN, hold styr paa koebte/laeste boeger og oenskeliste. Flere brugere, passkey-login og admin-styring. MCP-server til Claude. Egen SQLite-database - ingen eksterne afhaengigheder. Henter selv nyeste udgave ved genstart."
  author: "andreas"
  version: {RUNE_VERSION}
  icon: "app"

  # Node-versionen er et FELT i panelet, ikke en konstant i koden: findes der en CVE
  # i Node, kan den lukkes med "Opdater Min Bogreol" - uden kodeaendring.
  docker:
    image: "{{{{NODE_IMAGE}}}}"

  variables:
    - key: APP_NAME
      name: "Appens navn"
      type: string
      default: "Min Bogreol"
    - key: NODE_IMAGE
      name: "Node-image"
      type: string
      default: "node:24-alpine"
      pattern: '^node:[0-9][A-Za-z0-9._-]*$'
      hint: "Skal vaere et node:-image, fx node:24-alpine eller node:24.9.0-alpine"
    # TOM = nyeste. Et felt, man SKAL udfylde for at faa almindelig opfoersel,
    # laeses som en indstilling, nogen har taget - og saa staar der en laas,
    # ingen har bedt om. Spoergsmaalstegnet i moensteret er noedvendigt, ellers
    # kan den tomme standard ikke gemmes i panelet.
    - key: KODE_VERSION
      name: "Laas app-versionen (tom = nyeste)"
      type: string
      default: ""
      pattern: "^([0-9]+|seneste|latest)?$"

  install:
    image: "{{{{NODE_IMAGE}}}}"
    script: |
{indent(install_script.rstrip(), 6)}

  # Egen "Opdater Min Bogreol"-knap paa serversiden i panelet. Bruger app/kilde.js,
  # naar den findes; ellers hentes startsnorens udgave (opgraderingen fra v27).
  # Den gamle app FLYTTES vaek (ikke slettet), saa der aldrig er et sekund uden
  # app/. Knappen skifter kun filer - den genstarter ikke serveren.
  # Databasen (bogreol.db) ligger uden for app/ og bliver ikke roert.
  update:
    image: "{{{{NODE_IMAGE}}}}"
    label: "Opdater Min Bogreol"
    script: |
{indent(update_script.rstrip(), 6)}

  startup:
    # En genstart ER opdateringen: kilde.js henter nyeste udgave (eller den,
    # KODE_VERSION laaser til), FOER serveren starter.
    #
    # De foerste blokke rydder op efter en opdatering, der blev draebt undervejs:
    # en app draebt mellem de to mv'er saettes tilbage, en strandet laas ryddes
    # (`trap` naar ikke at koere ved et haardt drab), og et efterladt
    # .bogreol-gammel ved siden af en sund app fjernes.
    # node:sqlite er stabilt i Node 24; fallback-flaget daekker aeldre images.
    command: |
      if [ ! -f app/server.js ] && [ -f .bogreol-gammel/server.js ]; then
        rm -rf app
        mv .bogreol-gammel app
        echo "[kode] app/ sat tilbage efter en afbrudt udskiftning"
      fi
      if [ -d .bogreol-laas ]; then
        rm -rf .bogreol-laas .bogreol-ny
        echo "[kode] en strandet opdateringslaas er ryddet"
      fi
      if [ -f app/server.js ] && [ -d .bogreol-gammel ]; then rm -rf .bogreol-gammel; fi
      if [ -f app/kilde.js ]; then
        node app/kilde.js || echo "[kode] advarsel: opdateringen kunne ikke koeres"
      else
        echo "[kode] denne udgave henter ikke selv sin kode - brug knappen »Opdater Min Bogreol« i panelet"
      fi
      if node -e "require('node:sqlite')" >/dev/null 2>&1; then
        exec node app/server.js
      else
        exec node --experimental-sqlite app/server.js
      fi
    done_regex: 'Bogreol lytter'
    stop_timeout: 30

  ports:
    - {{ name: web, default: 3000, protocol: tcp }}

  watchers:
    - name: "Serverfejl i Bogreol"
      pattern: "\\\\[fejl\\\\]"
      threshold: 5
      window_secs: 300

  # Ruller op pr. IP i panelets sikkerhedshistorik (watcheren notificerer, events giver historik).
  events:
    - key: bogreol_login_fejl
      label: "Mislykket login i Bogreol"
      match: "\\\\[sikkerhed\\\\] login-fejl ip=(\\\\S+)"
    - key: bogreol_login_spaerret
      label: "Login spaerret af rate-limit"
      match: "\\\\[sikkerhed\\\\] login-spaerret ip=(\\\\S+)"

  backup:
    include: []

  # Wipe-knappen i panelet toemmer hele databasen (brugere + boeger) og starter forfra.
  # backup_first sikrer, at der altid ligger en frisk backup foer sletningen.
  wipe:
    paths: ["bogreol.db", "bogreol.db-wal", "bogreol.db-shm"]
    backup_first: true
"""

with open('runes/bogreol.yaml', 'w', encoding='utf-8') as f:
    f.write(rune)

import yaml
doc = yaml.safe_load(rune)
g = doc['gameskill']
assert g['id'] == 'bogreol' and g['docker']['image'] == '{{NODE_IMAGE}}' and g['startup']['command']
assert g['ports'][0]['name'] == 'web' and g['ports'][0]['protocol'] == 'tcp'
script = g['install']['script']
upd = g['update']['script']
_start = g['startup']['command']

_vars = {v['key']: v for v in g['variables']}
_re = re.compile(_vars['NODE_IMAGE']['pattern'])
assert _re.match('node:24-alpine') and _re.match('node:24.9.0-alpine') and not _re.match('alpine:3')
assert re.fullmatch(_vars['KODE_VERSION']['pattern'], ''), 'den tomme standard skal kunne gemmes'
assert 'GITHUB_TOKEN' not in rune, 'repoet er offentligt - runen skal ikke bede om et token'

# Runen bruges som STARTSNOR og maa aldrig pege paa en tag, der ikke findes.
assert g['version'] == RUNE_VERSION, 'runens version skal vaere RUNE_VERSION'
_tags = set(re.findall(r'refs/tags/v(\d+)', script + upd))
assert _tags == {str(RUNE_VERSION)}, (
    f'FEJL: runen peger paa tags {sorted(_tags)}, men startsnoren er v{RUNE_VERSION}.')

# Koden BAERES ikke laengere - den hentes.
for navn, txt in [('install', script), ('update', upd)]:
    assert 'YGG_PAYLOAD_EOF' not in txt, f'{navn} maa ikke baere en payload'
    assert len(txt) < 20_000, f'{navn} er {len(txt)} tegn - startsnoren skal vaere konstant lille'
    assert 'mv app .bogreol-gammel' in txt, f'FEJL: {navn} flytter ikke den gamle app vaek'
    assert 'bogreol.db' not in txt, f'FEJL: {navn} maa ALDRIG roere databasen'
    # En tom scanner-fil indlaeses uden fejl og blokerer CDN-reserven.
    assert '-O app/public/libs/html5-qrcode.min.js' not in txt, \
        f'FEJL: {navn} henter scanneren direkte til sin endelige sti - en fejl efterlader en tom fil'

def _kun_kode(t):
    # kommentarerne NAEVNER /tmp som det, vi ikke goer - vagten skal se paa koden
    return '\n'.join(l for l in t.split('\n') if not l.lstrip().startswith('#'))
for navn, txt in [('install', script), ('update', upd), ('startup', _start)]:
    assert '/tmp' not in _kun_kode(txt), f'FEJL: {navn} arbejder i /tmp'

# `rm -rf app` er KUN tilladt i redningen, hvor app/server.js allerede mangler.
_rm_app = re.compile(r'^\s*rm -rf app\s*$', re.M)
assert not _rm_app.search(script), 'FEJL: install sletter app/'
_redning_slut = upd.find('[kode] app/ sat tilbage')
assert _redning_slut >= 0, 'FEJL: update mangler redningen efter en afbrudt udskiftning'
assert len(_rm_app.findall(upd)) == 1, 'FEJL: update sletter app/ mere end ét sted'
assert _rm_app.search(upd).start() < _redning_slut, 'FEJL: update sletter app/ uden for redningen'

# Laasen skal daekke HELE opdateringen. Begge led SKAL findes, foer deres
# raekkefoelge siger noget: find() giver -1, og -1 er mindre end alt.
_i_laas = upd.find('mkdir .bogreol-laas')
_i_gren = upd.find('if [ -f app/kilde.js ]')
assert _i_laas >= 0 and _i_gren >= 0, 'FEJL: update mangler laasen eller forgreningen'
assert _redning_slut < _i_laas < _i_gren, 'FEJL: raekkefoelgen skal vaere redning -> laas -> forgrening'
assert "trap 'rm -rf .bogreol-laas" in upd, 'FEJL: laasen frigives ikke ved fejl'

_linjer = [l for l in upd.rstrip().split('\n') if l.strip()]
assert 'GENSTART MIN BOGREOL NU.' in '\n'.join(_linjer[-5:]), 'genstart-beskeden staar ikke til sidst'
assert _linjer[-1].strip() == 'echo "============================================"', \
    'genstart-beskedens ramme skal vaere det sidste, scriptet skriver'

assert '.bogreol-gammel' in _start and 'app/kilde.js' in _start
assert _start.index('mv .bogreol-gammel app') < _start.index('app/kilde.js'), \
    'startup skal saette en afbrudt udskiftning tilbage, FOER kilde.js koeres'
assert 'if [ -d .bogreol-laas ]' in _start, 'startup rydder ikke en strandet laas'
assert "require('node:sqlite')" in _start

# kilde.js skal tage scanner-biblioteket med, ellers forsvinder det ved foerste genstart.
assert 'bevarLibs(nyApp)' in kilde_js, 'FEJL: kilde.js tager ikke libs/ med over'

print(f'app: v{app_version} · rune: v{RUNE_VERSION}')
print(f'install-script: {len(script)} tegn (var 83.808 med payload) - peger paa v{RUNE_VERSION}')
print(f'update-script:  {len(upd)} tegn (var 85.402)')
if _usporet:
    print(f'\n  ADVARSEL: disse filer er IKKE committet, men skal med i taggen: {_usporet}')
    print('  Runen henter det, der er committet - ikke det, der ligger paa disken.')
if _aendret:
    print(f'\n  git: aendringer i app/ - husk commit + `git tag v{app_version}` + `git push --tags`.')
size = len(rune.encode())
print(f'\nbogreol.yaml OK - {size} bytes ({size/1024:.0f} KB af max 512 KB)')
assert size < 512 * 1024, 'for stor!'
if int(app_version) == RUNE_VERSION:
    print(f'\nRUNE_VERSION er ogsaa {RUNE_VERSION} denne gang, saa runen skal genindlaeses i panelet.')
else:
    print('\nRunen er UAENDRET - en genstart paa serveren henter den nye kode.')
print(f'Udgivelse er TRE trin: commit -> git tag v{app_version} -> git push --tags')
