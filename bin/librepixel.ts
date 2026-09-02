#!/usr/bin/env node

import type { AuthMode } from '../src/auth.ts';
import { openIndex, serve } from '../src/node.ts';
import type { RunningServer } from '../src/node.ts';
import { buildProfile, encodeProfile, setupLink } from '../src/profile.ts';
import { qrSvg, qrTerminal } from '../src/qr.ts';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';

const args = new Map<string, string | true>();
const argv = process.argv.slice(3);
for (let i = 0; i < argv.length; i++) {
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) args.set(argv[i], true);
  else args.set(argv[i], argv[++i]);
}

const option = (name: string): string | undefined => {
  const value = args.get(name);
  return typeof value === 'string' ? value : undefined;
};

const isAuthMode = (value: unknown): value is AuthMode => value === 'bearer' || value === 'exchange';

const command = process.argv[2] ?? 'serve';

const USAGE = `Usage

  librepixel serve [options]               Start the server (default)
    --port <port>                          Default 8788
    --dir <dir>                            Data directory, default ./data
    --host <address>                       Listen address, default 0.0.0.0
    --origin <URL>                         Address the phone uses
    --auth bearer|exchange                 Auth mode, default bearer
    --max-upload <bytes>                   Per-file size limit
    --trust-proxy                          Behind a reverse proxy

  librepixel setup-code [options]          Print the connection info again
    --link                                 Print it as a link
    --qr                                   Show a QR code in the terminal
    --svg <file>                           Save the QR code as SVG
    --dir --origin --auth --max-upload     Same as serve; the address and
                                           upload limit default to what serve
                                           last used with this --dir

  librepixel devices [--dir <dir>]         List bound devices
  librepixel unbind <issuer|all> [--dir <dir>]
                                           Unbind one or all devices
  librepixel help                          Show this help

Environment (flags take precedence)
  LIBREPIXEL_ORIGIN=https://...            Same as --origin
  LIBREPIXEL_TRUST_PROXY=1                 Same as --trust-proxy
  LIBREPIXEL_AUTH=exchange                 Same as --auth`;

if (['help', '--help', '-h'].includes(command) || args.has('--help') || args.has('-h')) {
  console.log(USAGE);
  process.exit(0);
}
function exitWith(message: string): never {
  console.error(message);
  process.exit(1);
}

function integerOption(name: string, min: number, max: number, unit = ''): number | undefined {
  const value = args.get(name);
  if (value === undefined) return undefined;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (Number.isSafeInteger(parsed) && parsed >= min && parsed <= max) return parsed;
  const range = max === Number.MAX_SAFE_INTEGER ? `at least ${min}` : `from ${min} to ${max}`;
  const given = value === true ? 'no value was given' : `got "${value}"`;
  return exitWith(`${name} must be a whole number${unit} ${range}; ${given}.`);
}

const shellWord = (word: string): string => (/^[\w./:@%+=,-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);

const dir = option('--dir') ?? './data';
const port = integerOption('--port', 1, 65535) ?? 8788;
const SERVER_FILE = 'server.json';

const chosen = option('--auth') ?? process.env.LIBREPIXEL_AUTH;
const saved = isAuthMode(chosen)
  ? chosen
  : (await readFile(join(dir, 'auth'), 'utf8').catch(() => '')).trim() || 'bearer';
const mode: AuthMode = isAuthMode(saved) ? saved : 'bearer';
const explicitOrigin = option('--origin') || process.env.LIBREPIXEL_ORIGIN || '';
const originOverride = explicitOrigin.replace(/\/+$/, '');
const trustProxy =
  args.has('--trust-proxy') || ['1', 'true', 'yes'].includes(process.env.LIBREPIXEL_TRUST_PROXY ?? '');
const maxUploadBytes = integerOption('--max-upload', 1, Number.MAX_SAFE_INTEGER, ' of bytes');

function lanAddress() {
  const candidates = Object.entries(networkInterfaces()).flatMap(([name, list]) =>
    (list ?? [])
      .filter((entry) => entry.family === 'IPv4' && !entry.internal)
      .map((entry) => ({ name, address: entry.address })),
  );
  const preferred = candidates.find((c) => c.name.startsWith('en')) ?? candidates[0];
  return preferred?.address ?? '127.0.0.1';
}

function startupProblem(error: unknown, { host }: { host: string }): string {
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  switch (code) {
    case 'EADDRINUSE':
      return `Port ${port} is already in use. Pick another --port, or stop whatever is using it.`;
    case 'EADDRNOTAVAIL':
      return `Can't listen on ${host}: this machine has no such address. Check --host.`;
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return (
        `Permission denied: can't write to the data directory ${dir} or use port ${port} (${code}). Check the directory's permissions, or pick another --dir or --port.`
      );
    default:
      return `LibrePixel failed to start: ${error instanceof Error ? error.message : error}`;
  }
}

if (command === 'serve') {
  const host = option('--host') ?? '0.0.0.0';
  const reachable = originOverride || `http://${host === '0.0.0.0' ? lanAddress() : host}:${port}`;
  let running: RunningServer;
  try {
    running = await serve({
      port,
      dir,
      host,
      origin: reachable,
      mode,
      maxUploadBytes,
      trustProxy,
    });
    await writeFile(join(dir, 'auth'), `${mode}\n`);
    await writeFile(join(dir, SERVER_FILE), `${JSON.stringify({ origin: reachable, maxUploadBytes })}\n`);
  } catch (error) {
    console.error(startupProblem(error, { host }));
    process.exit(1);
  }
  console.log(
    `LibrePixel is running at ${reachable} (listening on ${host}:${port}, data in ${dir}, auth mode ${mode})`,
  );
  const code = encodeProfile(buildProfile(reachable, running.token, { mode, maxUploadBytes }));
  const dirFlag = dir === './data' ? '' : ` --dir ${shellWord(dir)}`;
  console.log(`Connection info (paste it into the app):\n${code}`);
  console.log(
    `Anyone with the connection info can access this server. It stays in this log (docker logs, for example), so share the log only with people you trust.`,
  );
  console.log(`To show a QR code in the terminal, run librepixel setup-code${dirFlag} --qr.`);
  console.log(
    `Open ${reachable}/ in a browser to see backed-up photos and the connection info. Enter any username; the password is the contents of ${join(dir, 'token')}.`,
  );
} else if (command === 'setup-code') {
  const tokenPath = join(dir, 'token');
  const token = (
    await readFile(tokenPath, 'utf8').catch(() => {
      console.error(`Can't find ${tokenPath}. Run librepixel serve once with the same --dir first.`);
      process.exit(1);
    })
  ).trim();
  if (args.has('--port') || args.has('--host')) {
    exitWith(`setup-code uses the address serve saved in ${join(dir, SERVER_FILE)}. To use a different one, pass --origin.`);
  }
  const savedServer: { origin?: unknown; maxUploadBytes?: unknown } = await readFile(join(dir, SERVER_FILE), 'utf8')
    .then((text) => JSON.parse(text))
    .catch(() => ({}));
  const origin = originOverride || (typeof savedServer.origin === 'string' ? savedServer.origin : '');
  if (!origin) {
    exitWith(
      `Can't find the server address in ${join(dir, SERVER_FILE)}. Run librepixel serve once with the same --dir, or pass --origin.`,
    );
  }
  const savedLimit = Number.isSafeInteger(savedServer.maxUploadBytes) ? Number(savedServer.maxUploadBytes) : undefined;
  const code = encodeProfile(
    buildProfile(origin, token, { mode, maxUploadBytes: maxUploadBytes ?? savedLimit }),
  );
  const link = setupLink(code);

  if (args.has('--svg')) {
    const path = option('--svg') ?? 'librepixel-setup.svg';
    await writeFile(path, qrSvg(link, { scale: 6, margin: 4 }), { mode: 0o600 });
    await chmod(path, 0o600);
    console.error(`QR code saved to ${path}`);
  }
  if (args.has('--qr')) {
    console.log(qrTerminal(link, { margin: 2 }));
  }
  if (!args.has('--qr') && !args.has('--svg')) {
    console.log(args.has('--link') ? link : code);
  }
} else if (command === 'devices') {
  bearerHint();
  const { index, close } = await openIndex(dir);
  const keys = await index.listBindingKeys();
  close();
  if (keys.length === 0) {
    console.log('No devices are bound.');
  } else {
    console.log('Issuer\tName\tBound (UTC)');
    for (const key of keys) {
      const when = new Date((key.created_at ?? 0) * 1000).toISOString().slice(0, 19).replace('T', ' ');
      console.log(`${key.issuer}\t${key.label ?? '(unnamed)'}\t${when}`);
    }
  }
} else if (command === 'unbind') {
  const target = argv[0];
  if (!target || target.startsWith('--')) {
    console.error('Usage: librepixel unbind <issuer|all>');
    process.exit(1);
  }
  bearerHint();
  const { index, close } = await openIndex(dir);
  const removed =
    target === 'all' ? await index.deleteAllBindingKeys() : await index.deleteBindingKey(target);
  close();
  if (removed > 0) {
    console.log(
      target === 'all'
        ? `Unbound all ${removed} ${removed === 1 ? 'device' : 'devices'}. The next device can bind with just the connection info.`
        : `Unbound ${removed} ${removed === 1 ? 'device' : 'devices'}.`,
    );
  } else {
    console.log('No matching device. Run librepixel devices to list bound devices.');
  }
} else {
  console.error(`Unknown command: ${command}\n\n${USAGE}`);
  process.exit(1);
}

function bearerHint() {
  if (mode !== 'bearer') return;
  console.error(
    'The auth mode is bearer, so devices are not bound. Start serve with --auth exchange to bind devices.',
  );
}
