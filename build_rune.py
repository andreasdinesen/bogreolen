#!/usr/bin/env python3
"""Byg bogreol.yaml – en Yggdrasil Panel-rune der indlejrer hele appen."""
import base64, re, sys

def read(p):
    with open(p, encoding='utf-8') as f:
        return f.read()

server_js = read('app/server.js')
index_html = read('app/public/index.html')
icon192 = base64.b64encode(open('app/public/icon-192.png', 'rb').read()).decode()
icon512 = base64.b64encode(open('app/public/icon-512.png', 'rb').read()).decode()

# --- sikkerhedstjek ---
for name, txt in [('server.js', server_js), ('index.html', index_html)]:
    hits = set(re.findall(r'\{\{[A-Z_]+\}\}', txt))
    if hits:
        sys.exit(f'FEJL: {name} indeholder skabelon-kollisioner: {hits}')
    for eof in ['YGG_SERVER_EOF', 'YGG_INDEX_EOF', 'YGG_ICON1_EOF', 'YGG_ICON2_EOF']:
        if eof in txt:
            sys.exit(f'FEJL: {name} indeholder heredoc-markøren {eof}')
    if '\t' in txt:
        print(f'advarsel: {name} indeholder tab-tegn (ok i YAML-blokindhold)')

def b64_wrap(s, width=100):
    return '\n'.join(s[i:i+width] for i in range(0, len(s), width))

install_script = f"""set -eu
echo "Installerer Min Bogreol ..."
mkdir -p app/public/libs

cat > app/server.js <<'YGG_SERVER_EOF'
{server_js.rstrip()}
YGG_SERVER_EOF

cat > app/public/index.html <<'YGG_INDEX_EOF'
{index_html.rstrip()}
YGG_INDEX_EOF

base64 -d > app/public/icon-192.png <<'YGG_ICON1_EOF'
{b64_wrap(icon192)}
YGG_ICON1_EOF

base64 -d > app/public/icon-512.png <<'YGG_ICON2_EOF'
{b64_wrap(icon512)}
YGG_ICON2_EOF

# Stregkode-scanneren hentes lokalt, saa appen ikke afhaenger af CDN paa telefonen.
# Fejler download, falder appen selv tilbage til CDN ved brug.
wget -q -O app/public/libs/html5-qrcode.min.js https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js \\
  || echo "advarsel: kunne ikke hente scanner-biblioteket nu - appen bruger CDN i stedet"

node --version
echo "Min Bogreol er installeret."
"""

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
  version: 4
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
"""

with open('runes/bogreol.yaml', 'w', encoding='utf-8') as f:
    f.write(rune)

import yaml
doc = yaml.safe_load(rune)
g = doc['gameskill']
assert g['id'] == 'bogreol' and g['docker']['image'] and g['startup']['command']
assert g['ports'][0]['name'] == 'web' and g['ports'][0]['protocol'] == 'tcp'
script = g['install']['script']
assert 'YGG_SERVER_EOF' in script and script.count('YGG_SERVER_EOF') == 2
assert "require('node:sqlite')" in g['startup']['command']
size = len(rune.encode())
print(f'bogreol.yaml OK - {size} bytes ({size/1024:.0f} KB af max 512 KB)')
assert size < 512 * 1024, 'for stor!'
