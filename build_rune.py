#!/usr/bin/env python3
"""Byg bogreol.yaml – en Yggdrasil Panel-rune der indlejrer hele appen.

Payloaden (alle app-filer) pakkes som brotli-komprimeret tar i base85 og
verificeres byte-identisk med PRAECIS den dekoder, der udgives (RUNE-ERFARINGER §2).
"""
import base64, glob, io, os, re, subprocess, sys, tarfile

def read(p):
    with open(p, encoding='utf-8') as f:
        return f.read()

server_js = read('app/server.js')
index_html = read('app/public/index.html')

m = re.search(r'const APP_VERSION = (\d+);', index_html)
if not m:
    sys.exit('FEJL: APP_VERSION ikke fundet i index.html')
app_version = m.group(1)

# --- payloadens filer: glob, ikke haandholdt liste (Beanledger v30: to uinstallerbare
# versioner fordi mcp.js/oauth.js manglede). Alt server.js require'r relativt SKAL med.
FILES = ['app/public/index.html', 'app/public/icon-192.png', 'app/public/icon-512.png'] \
    + sorted(glob.glob('app/*.js')) + sorted(glob.glob('app/shared/*.js'))
_krav = set()
for _f in glob.glob('app/*.js') + glob.glob('app/shared/*.js'):
    for _r in re.findall(r"require\(['\"](\./[^'\"]+)['\"]\)", read(_f)):
        _p = os.path.normpath(os.path.join(os.path.dirname(_f), _r))
        if not _p.endswith('.js'):
            _p += '.js'
        _krav.add(_p)
_mangler = sorted(x for x in _krav if x not in FILES)
if _mangler:
    sys.exit(f'FEJL: disse require-filer mangler i payloaden: {_mangler}')

# --- sikkerhedstjek ---
for name in [f for f in FILES if f.endswith(('.js', '.html'))]:
    txt = read(name)
    hits = set(re.findall(r'\{\{[A-Z_]+\}\}', txt))
    if hits:
        sys.exit(f'FEJL: {name} indeholder skabelon-kollisioner: {hits}')
    if 'YGG_PAYLOAD_EOF' in txt:
        sys.exit(f'FEJL: {name} indeholder heredoc-markøren YGG_PAYLOAD_EOF')
    if name.endswith('.js'):
        subprocess.run(['node', '--check', name], check=True)

def wrap(s, width=100):
    return '\n'.join(s[i:i+width] for i in range(0, len(s), width))

# --- tar ---
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode='w') as tar:
    for path in FILES:
        info = tarfile.TarInfo(path)
        data = open(path, 'rb').read()
        info.size = len(data)
        info.mtime = 0
        tar.addfile(info, io.BytesIO(data))
tar_bytes = buf.getvalue()

# --- brotli (Python har det ikke i stdlib - kald node; install-imaget ER node) ---
komprimeret = subprocess.run(
    ['node', '-e',
     'const z=require("zlib");const b=[];process.stdin.on("data",c=>b.push(c))'
     '.on("end",()=>process.stdout.write(z.brotliCompressSync(Buffer.concat(b),'
     '{params:{[z.constants.BROTLI_PARAM_QUALITY]:11}})));'],
    input=tar_bytes, stdout=subprocess.PIPE, check=True).stdout

# --- base85: alfabetet udelader ` { } - saa payloaden aldrig kan ligne panelets
# {{VARIABEL}}-skabeloner eller aabne en kommandosubstitution. Delblok padder bytes med 0x00.
B85 = [c for c in range(33, 127) if c not in (96, 123, 125)][:85]
def b85_encode(data):
    ud = bytearray()
    for i in range(0, len(data), 4):
        stykke = data[i:i + 4]
        n = len(stykke)
        v = int.from_bytes(stykke + b'\0' * (4 - n), 'big')
        cifre = []
        for _ in range(5):
            cifre.append(v % 85)
            v //= 85
        cifre.reverse()
        ud.extend(B85[d] for d in cifre[:n + 1])
    return ud.decode('ascii')
payload = b85_encode(komprimeret)

# Dekoderen staar i en 'single quoted' sh-streng og maa ikke indeholde apostroffer -
# alfabetet bygges af tegnkoder. Manglende cifre i sidste blok fyldes med 84 (max).
DEKODER = (
    'const A=[];for(let c=33;c<127;c++){if(c!==96&&c!==123&&c!==125)A.push(c);}'
    'const M=new Map();for(let i=0;i<85;i++)M.set(A[i],i);'
    'const s=require("fs").readFileSync(0,"utf8").replace(/\\s+/g,"");'
    'const o=[];'
    'for(let i=0;i<s.length;i+=5){const n=Math.min(5,s.length-i);let v=0;'
    'for(let j=0;j<5;j++){v=v*85+(j<n?M.get(s.charCodeAt(i+j)):84);}'
    'const b=[(v/16777216)&255,(v/65536)&255,(v/256)&255,v&255];'
    'for(let j=0;j<n-1;j++)o.push(b[j]);}'
    'process.stdout.write(require("zlib").brotliDecompressSync(Buffer.from(o)));'
)

install_script = f"""set -eu
echo "Installerer Min Bogreol v{app_version} ..."

# App-filerne ligger som brotli-komprimeret tar i base85 - se build_rune.py
node -e '{DEKODER}' <<'YGG_PAYLOAD_EOF' | tar x
{wrap(payload)}
YGG_PAYLOAD_EOF

mkdir -p app/public/libs

# Stregkode-scanneren hentes lokalt, saa appen ikke afhaenger af CDN paa telefonen.
# Fejler download, falder appen selv tilbage til CDN ved brug.
wget -q -O app/public/libs/html5-qrcode.min.js https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js \\
  || echo "advarsel: kunne ikke hente scanner-biblioteket nu - appen bruger CDN i stedet"

echo "Node: $(node --version)"
echo "Min Bogreol v{app_version} er installeret."
"""

# Opdaterings-scriptet: samme payload, men app/ ryddes FOERST, saa filer fjernet i en ny
# version ikke bliver liggende (tar overskriver, men sletter ikke). Datamappen roeres ikke.
# libs/ ligger under app/ og hentes derfor igen.
update_script = f"""set -eu
echo "Opdaterer Min Bogreol til v{app_version} ..."
echo "Node: $(node --version)"

rm -rf app

# Samme brotli+base85-payload som install - se build_rune.py
node -e '{DEKODER}' <<'YGG_PAYLOAD_EOF' | tar x
{wrap(payload)}
YGG_PAYLOAD_EOF

mkdir -p app/public/libs
wget -q -O app/public/libs/html5-qrcode.min.js https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js \\
  || echo "advarsel: kunne ikke hente scanner-biblioteket nu - appen bruger CDN i stedet"

echo "Min Bogreol er opdateret til v{app_version}. Databasen er uroert."
"""

# Panelet koerer scriptet som ETT sh -c-argument; Linux' MAX_ARG_STRLEN er 131072 b.
for _navn, _s in [('install', install_script), ('update', update_script)]:
    assert len(_s) < 110_000, (
        f'FEJL: {_navn}-scriptet er {len(_s)} tegn - taet paa/over sh -c-graensen (~128 KiB).')

def indent(text, spaces):
    pad = ' ' * spaces
    return '\n'.join(pad + line if line.strip() else '' for line in text.split('\n'))

rune = f"""# Min Bogreol - personligt bogbibliotek som Yggdrasil-rune
# Alt (app + SQLite-database) ligger i serverens egen datamappe.
gameskill:
  id: bogreol
  name: "Min Bogreol"
  category: "Apps"
  description: "Personligt bogbibliotek: scan ISBN, hold styr paa koebte/laeste boeger og oenskeliste. Flere brugere, passkey-login og admin-styring. MCP-server til Claude. Egen SQLite-database - ingen eksterne afhaengigheder."
  author: "andreas"
  version: {app_version}
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

  install:
    image: "{{{{NODE_IMAGE}}}}"
    script: |
{indent(install_script.rstrip(), 6)}

  # Egen "Opdater Min Bogreol"-knap paa serversiden i panelet: skriver app-filerne igen
  # uden at roere datamappen. `rm -rf app` foerst, saa filer der er FJERNET i en ny
  # version ogsaa forsvinder. Databasen (bogreol.db) ligger uden for app/.
  update:
    image: "{{{{NODE_IMAGE}}}}"
    label: "Opdater Min Bogreol"
    script: |
{indent(update_script.rstrip(), 6)}

  startup:
    # node:sqlite er stabilt i Node 24; fallback-flaget daekker aeldre images.
    command: |
      if node -e "require('node:sqlite')" >/dev/null 2>&1; then exec node app/server.js; else exec node --experimental-sqlite app/server.js; fi
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
assert any(v['key'] == 'NODE_IMAGE' and v.get('pattern') for v in g['variables'])
assert "require('node:sqlite')" in g['startup']['command']
assert 'bogreol.db' not in g['update']['script'], 'opdateringen maa ALDRIG roere databasen'
assert re.search(r'^\s*rm -rf app\s*$', g['update']['script'], re.M), 'opdateringen rydder ikke app/'
assert re.match(r'^node:[0-9]', 'node:24-alpine')  # pattern-eksempel
_re = re.compile(next(v['pattern'] for v in g['variables'] if v['key'] == 'NODE_IMAGE'))
assert _re.match('node:24-alpine') and _re.match('node:24.9.0-alpine') and not _re.match('alpine:3')

# Rundtur: dekod payloaden fra BEGGE scripts med praecis den dekoder, der udgives.
for _navn in ('install', 'update'):
    _script = g[_navn]['script']
    assert _script.count('YGG_PAYLOAD_EOF') == 2
    _m = re.search(r"\| tar x\n(.*?)\nYGG_PAYLOAD_EOF", _script, re.S)
    _tar = tarfile.open(fileobj=io.BytesIO(subprocess.run(
        ['node', '-e', DEKODER], input=_m.group(1).encode(), stdout=subprocess.PIPE, check=True).stdout))
    _navne = set(_tar.getnames())
    assert _navne == set(FILES), f'{_navn}: payload-filliste afviger: {_navne ^ set(FILES)}'
    for _p in FILES:
        assert _tar.extractfile(_p).read() == open(_p, 'rb').read(), f'{_navn}: payload afviger for {_p}'
    print(f'{_navn}-script: {len(_script)} tegn (sh -c-graense ~131072); payload verificeret byte-identisk ({len(FILES)} filer)')

size = len(rune.encode())
print(f'bogreol.yaml OK - {size} bytes ({size/1024:.0f} KB af max 512 KB) - version {app_version}')
assert size < 512 * 1024, 'for stor!'
