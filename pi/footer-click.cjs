#!/usr/bin/env node
'use strict';
const net = require('node:net');
const fs = require('node:fs');

function target(value) {
  const match = typeof value === 'string' && value.length < 160 && /^pi-gateway-action:\/\/([1-9][0-9]*-[0-9a-f]{8})\/([0-9a-f]{32})$/.exec(value);
  const uid = process.getuid?.();
  if (!match || match[0] !== value || uid === undefined) throw new Error('Invalid action link');
  const dir = `/tmp/pi-gateway-actions-${uid}`, file = `${dir}/${match[1]}.sock`;
  for (const [name, mode, kind] of [[dir, 0o700, 'isDirectory'], [file, 0o600, 'isSocket']]) {
    const stat = fs.lstatSync(name);
    if (!stat[kind]() || stat.uid !== uid || (stat.mode & 0o777) !== mode) throw new Error('Unsafe action socket');
  }
  return { file, token: match[2] };
}
function click(value, secondary = false) {
  let parsed;
  try { parsed = target(value); } catch { return Promise.reject(new Error('Action unavailable')); }
  return new Promise((resolve, reject) => {
    const client = net.createConnection(parsed.file);
    let response = '', done = false;
    const finish = (accepted) => { if (done) return; done = true; clearTimeout(timer); client.destroy(); accepted ? resolve(true) : reject(new Error('Action unavailable')); };
    // The host owns accepted actions; helper exit cannot cancel an in-flight write.
    const timer = setTimeout(() => finish(false), 300_000);
    client.on('connect', () => client.write(`${parsed.token}${secondary ? ' secondary' : ''}\n`));
    client.on('data', (chunk) => { response += chunk.toString('utf8'); if (response.length > 32 || response.includes('\n')) finish(response === 'accepted\n'); });
    client.on('error', () => finish(false));
    client.on('end', () => finish(false));
  });
}
if (require.main === module) {
  const args = process.argv.slice(2), secondary = args[0] === '--secondary';
  if (secondary) args.shift();
  if (args.length !== 1) { console.error('Usage: footer-click.cjs [--secondary] <action URL>'); process.exitCode = 2; }
  else click(args[0], secondary).catch(() => { console.error('Gateway action unavailable; finish any dialog and reopen the service app.'); process.exitCode = 1; });
}
module.exports = { click };
