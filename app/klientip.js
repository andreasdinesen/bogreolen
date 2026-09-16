/*
 * Hvem er klienten? - én regel, kopieret RAAT til alle runer.
 *
 * Indtil 2026-09-16 tog runerne den FOERSTE vaerdi i X-Forwarded-For. Den
 * vaelger klienten selv: `X-Forwarded-For: 1.2.3.4` i en forespoergsel, og
 * hver proxy paa vejen LAEGGER sin egen vaerdi til bagerst. En angriber kunne
 * derfor skifte "IP" ved hvert kald og gaa uden om login-spaerringen og
 * soegelofter - og fylde panelets sikkerhedshistorik med opdigtede adresser.
 *
 * Reglen her er »den bageste, vi ikke selv har sat«:
 *
 *  1. Kommer forbindelsen fra en OFFENTLIG adresse, er der ingen proxy foran
 *     os. Saa er socket-adressen svaret, og headeren ignoreres helt.
 *  2. Kommer den fra en privat/loopback-adresse (tunnelen, Nginx Proxy
 *     Manager, docker-nettet), laeses headeren BAGFRA. Hver adresse, der er
 *     privat eller tilhoerer Cloudflare, er et led i vores egen kaede og
 *     springes over. Den foerste, der ikke er, er klienten.
 *  3. Er alle led private (en klient paa hjemmenettet gennem en lokal proxy),
 *     er den bageste vaerdi klienten, som den naermeste proxy saa den.
 *
 * Tilbage staar ét hul, som ingen header-regel kan lukke: en maskine paa
 * HJEMMENETTET, der gaar direkte til IP:port og selv saetter headeren. Den er
 * inden for murene i forvejen.
 *
 * Cloudflares adresser er hentet fra cloudflare.com/ips-v4 og /ips-v6
 * 2026-09-16. De skifter sjaeldent; en ny raekke betyder i vaerste fald, at
 * Cloudflare-kanten ses som klienten (alle deler én spand) - aldrig, at en
 * klient kan vaelge sin egen adresse.
 */

'use strict';

const net = require('node:net');

const EGNE = new net.BlockList();
for (const [a, n] of [
  // loopback, privat, link-local, CGNAT, uspecificeret
  ['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16],
  ['169.254.0.0', 16], ['100.64.0.0', 10], ['0.0.0.0', 8],
  // Cloudflare
  ['173.245.48.0', 20], ['103.21.244.0', 22], ['103.22.200.0', 22], ['103.31.4.0', 22],
  ['141.101.64.0', 18], ['108.162.192.0', 18], ['190.93.240.0', 20], ['188.114.96.0', 20],
  ['197.234.240.0', 22], ['198.41.128.0', 17], ['162.158.0.0', 15], ['104.16.0.0', 13],
  ['104.24.0.0', 14], ['172.64.0.0', 13], ['131.0.72.0', 22],
]) EGNE.addSubnet(a, n, 'ipv4');
for (const [a, n] of [
  ['::1', 128], ['::', 128], ['fc00::', 7], ['fe80::', 10],
  ['2400:cb00::', 32], ['2606:4700::', 32], ['2803:f800::', 32], ['2405:b500::', 32],
  ['2405:8100::', 32], ['2a06:98c0::', 29], ['2c0f:f248::', 32],
]) EGNE.addSubnet(a, n, 'ipv6');

/** '::ffff:10.0.0.1' -> '10.0.0.1', '[::1]:80'/'1.2.3.4:80' -> uden port. Ugyldig -> ''. */
function rens(raa) {
  let s = String(raa || '').trim();
  if (s.startsWith('[')) s = s.slice(1, s.indexOf(']') > 0 ? s.indexOf(']') : undefined);
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(':'));
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(s)) s = s.slice(7);
  return net.isIP(s) ? s : '';
}

function erEgen(ip) {
  const v = net.isIP(ip);
  return v ? EGNE.check(ip, v === 6 ? 'ipv6' : 'ipv4') : false;
}

/**
 * Klientens adresse - aldrig en vaerdi, klienten selv har valgt, naar der
 * staar en proxy foran os.
 */
function klientIp(req) {
  const sokkel = rens(req && req.socket && req.socket.remoteAddress);
  if (sokkel && !erEgen(sokkel)) return sokkel;

  const raa = req && req.headers ? req.headers['x-forwarded-for'] : '';
  const led = String(Array.isArray(raa) ? raa.join(',') : (raa || ''))
    .split(',').map(rens).filter(Boolean);
  for (let i = led.length - 1; i >= 0; i -= 1) {
    if (!erEgen(led[i])) return led[i];
  }
  if (led.length) return led[led.length - 1];
  return sokkel || 'ukendt';
}

module.exports = { klientIp, erEgen, rens };
