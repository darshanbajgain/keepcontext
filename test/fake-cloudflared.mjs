#!/usr/bin/env node
// Fake cloudflared for the tests (CLOUDFLARED_BIN). Prints what the real one prints, never touches the network.
//   --version                 → exit 0
//   tunnel ... --url <local>  → a new random https://….trycloudflare.com address on every start
//   tunnel ... run            → "Registered tunnel connection" if TUNNEL_TOKEN is the test token, else an error
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('cloudflared version 0.0.0-test'); process.exit(0); }
// The real token must never be on the command line.
if (args.some((a) => a.includes('cf-test-token'))) { console.error('ERR token on the command line'); process.exit(2); }
const say = (s) => process.stderr.write(`2026-01-01T00:00:00Z INF ${s}\n`);
setTimeout(() => {
  if (args.includes('--url')) {
    say('Requesting new quick Tunnel on trycloudflare.com...');
    say('+--------------------------------------------------------------------------------------------+');
    say(`|  https://fake-${Math.random().toString(36).slice(2, 10)}.trycloudflare.com                                   |`);
    say('+--------------------------------------------------------------------------------------------+');
  } else if (args.includes('run')) {
    if (process.env.TUNNEL_TOKEN !== 'cf-test-token-0123456789') {
      process.stderr.write('2026-01-01T00:00:00Z ERR Provided Tunnel token is not valid.\n');
      process.exit(1);
    }
    say('Registered tunnel connection connIndex=0 location=test protocol=quic');
  }
}, 150);
setInterval(() => {}, 1e6);
process.on('SIGTERM', () => process.exit(0));
