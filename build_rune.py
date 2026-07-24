#!/usr/bin/env python3
"""Byg bogreol.yaml – en Yggdrasil Panel-rune der indlejrer hele appen."""
import base64, re, sys

def read(p):
    with open(p, encoding='utf-8') as f:
        return f.read()

server_js = read('app/server.js')
index_html = read('app/public/index.html')

m = re.search(r'const APP_VERSION = (\d+);', index_html)
if not m:
    sys.exit('FEJL: APP_VERSION ikke fundet i index.html')
app_version = m.group(1)

# --- sikkerhedstjek ---
for name, txt in [('server.js', server_js), ('index.html', index_html)]:
    hits = set(re.findall(r'\{\{[A-Z_]+\}\}', txt))
    if hits:
        sys.exit(f'FEJL: {name} indeholder skabelon-kollisioner: {hits}')
    if 'YGG_PAYLOAD_EOF' in txt:
        sys.exit(f'FEJL: {name} indeholder heredoc-markøren YGG_PAYLOAD_EOF')
    if '\t' in txt:
        print(f'advarsel: {name} indeholder tab-tegn (ok i YAML-blokindhold)')

def b64_wrap(s, width=100):
    return '\n'.join(s[i:i+width] for i in range(0, len(s), width))

# Alle app-filer pakkes som gzippet tar (base64) - panelet koerer install-scriptet som ETT
# sh -c-argument, og Linux' MAX_ARG_STRLEN (~128 KiB) saetter loftet. Raa heredocs sprang
# den graense ved v9 ("argument list too long"); komprimeret payload holder os langt under.
import io, tarfile, gzip, time
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode='w') as tar:
    for path in ['app/server.js', 'app/public/index.html', 'app/public/icon-192.png', 'app/public/icon-512.png']:
        info = tarfile.TarInfo(path)
        data = open(path, 'rb').read()
        info.size = len(data)
        info.mtime = 0
        tar.addfile(info, io.BytesIO(data))
payload = base64.b64encode(gzip.compress(buf.getvalue(), 9, mtime=0)).decode()

install_script = f"""set -eu
echo "Installerer Min Bogreol ..."

# App-filerne ligger som gzippet tar-arkiv (base64) - se build_rune.py
base64 -d <<'YGG_PAYLOAD_EOF' | gunzip | tar x
{b64_wrap(payload)}
YGG_PAYLOAD_EOF

mkdir -p app/public/libs

# Stregkode-scanneren hentes lokalt, saa appen ikke afhaenger af CDN paa telefonen.
# Fejler download, falder appen selv tilbage til CDN ved brug.
wget -q -O app/public/libs/html5-qrcode.min.js https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js \\
  || echo "advarsel: kunne ikke hente scanner-biblioteket nu - appen bruger CDN i stedet"

node --version
echo "Min Bogreol er installeret."
"""

assert len(install_script) < 110_000, (
    f'FEJL: install-scriptet er {len(install_script)} tegn - taet paa/over sh -c-graensen (~128 KiB). '
    'Reducer payload eller split leveringen.')

def indent(text, spaces):
    pad = ' ' * spaces
    return '\n'.join(pad + line if line.strip() else '' for line in text.split('\n'))

rune = f"""# Min Bogreol - personligt bogbibliotek som Yggdrasil-rune
# Alt (app + SQLite-database) ligger i serverens egen datamappe.
gameskill:
  id: bogreol
  name: "Min Bogreol"
  category: "Apps"
  description: "Personligt bogbibliotek: scan ISBN, hold styr paa koebte/laeste boeger og oenskeliste. Flere brugere, passkey-login og admin-styring. Egen SQLite-database - ingen eksterne afhaengigheder."
  author: "andreas"
  version: {app_version}
  icon: "app"

  docker:
    image: "node:24-alpine"

  variables:
    - key: APP_NAME
      name: "Appens navn"
      type: string
      default: "Min Bogreol"

  install:
    image: "node:24-alpine"
    script: |
{indent(install_script.rstrip(), 6)}

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
assert g['id'] == 'bogreol' and g['docker']['image'] and g['startup']['command']
assert g['ports'][0]['name'] == 'web' and g['ports'][0]['protocol'] == 'tcp'
script = g['install']['script']
assert script.count('YGG_PAYLOAD_EOF') == 2
# Rundtur: dekod payloaden fra scriptet og verificer, at filerne er byte-identiske med kilderne
_m = re.search(r"\| gunzip \| tar x\n(.*?)\nYGG_PAYLOAD_EOF", script, re.S)
_tar = tarfile.open(fileobj=io.BytesIO(gzip.decompress(base64.b64decode(_m.group(1)))))
for _p in ['app/server.js', 'app/public/index.html', 'app/public/icon-192.png', 'app/public/icon-512.png']:
    assert _tar.extractfile(_p).read() == open(_p, 'rb').read(), f'payload afviger for {_p}'
assert "require('node:sqlite')" in g['startup']['command']
print(f'install-script: {len(script)} tegn (sh -c-graense ~131072); payload verificeret byte-identisk')
size = len(rune.encode())
print(f'bogreol.yaml OK - {size} bytes ({size/1024:.0f} KB af max 512 KB)')
assert size < 512 * 1024, 'for stor!'
