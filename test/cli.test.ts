import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { BindingClient, FORM_HEADERS, form, startServer } from './support.ts';
import type { TestServer } from './support.ts';
import { decodeProfile } from '../src/profile.ts';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/librepixel.ts', import.meta.url));
const librepixel = (args: string[], env: Record<string, string> = {}) =>
  run(process.execPath, [cli, ...args], { env: { ...process.env, ...env } });

interface ExecFailure {
  code: number;
  stderr: string;
}

const isExecFailure = (error: unknown): error is ExecFailure =>
  error instanceof Error && 'code' in error && 'stderr' in error;

let running: TestServer;

before(async () => {
  running = await startServer({ mode: 'exchange' });
});

after(async () => {
  await running.stop();
});

test('devices lists registered devices, unbind all clears them', async () => {
  const empty = await librepixel(['devices', '--dir', running.dir]);
  assert.match(empty.stdout, /No devices are bound/);

  const device = await BindingClient.create();
  const spki = Buffer.from(await device.publicKeySPKI()).toString('base64url');
  const res = await fetch(`${running.origin}/v1/register`, {
    method: 'POST',
    headers: { ...FORM_HEADERS, authorization: `Bearer ${running.token}` },
    body: form({ public_key: spki, label: 'test-phone' }),
  });
  assert.equal(res.status, 200);
  await res.text();

  const listed = await librepixel(['devices', '--dir', running.dir]);
  assert.match(listed.stdout, new RegExp(await device.issuer()));
  assert.match(listed.stdout, /test-phone/);

  const removed = await librepixel(['unbind', 'all', '--dir', running.dir]);
  assert.match(removed.stdout, /1/);
  assert.equal((await running.index.listBindingKeys()).length, 0);
});

test('setup-code: --origin wins over LIBREPIXEL_ORIGIN', async () => {
  const flag = await librepixel(['setup-code', '--dir', running.dir, '--origin', 'https://a.example.com']);
  assert.equal(decodeProfile(flag.stdout.trim()).server, 'a.example.com');

  const env = await librepixel(['setup-code', '--dir', running.dir], {
    LIBREPIXEL_ORIGIN: 'https://b.example.com/',
  });
  const profile = decodeProfile(env.stdout.trim());
  assert.equal(profile.server, 'b.example.com');
  assert.equal(profile.endpoints.find, 'https://b.example.com/v1/find', 'a trailing slash does not become a double slash');
});

test('setup-code --qr prints half-block characters, --svg writes an SVG file', async () => {
  const qr = await librepixel(['setup-code', '--dir', running.dir, '--origin', 'https://c.example.com', '--qr']);
  assert.match(qr.stdout, /[▀▄█]/);

  const path = join(running.dir, 'setup.svg');
  await librepixel(['setup-code', '--dir', running.dir, '--origin', 'https://c.example.com', '--svg', path]);
  const svg = await readFile(path, 'utf8');
  assert.match(svg, /^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.equal((await stat(path)).mode & 0o777, 0o600, 'the QR code carries the token, so only the owner can read it');
});

const expectExit = (args: string[], pattern: RegExp) =>
  assert.rejects(librepixel(args), (error) => {
    assert.ok(isExecFailure(error));
    assert.equal(error.code, 1);
    assert.match(error.stderr, pattern);
    assert.doesNotMatch(error.stderr, /\n\s+at /, 'no stack trace');
    return true;
  });

test('numeric options are checked before starting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'librepixel-cli-'));
  try {
    const base = ['serve', '--dir', dir, '--host', '127.0.0.1'];
    await expectExit([...base, '--max-upload', 'abc'], /--max-upload must be a whole number of bytes at least 1; got "abc"/);
    await expectExit([...base, '--max-upload'], /--max-upload must be a whole number of bytes at least 1; no value was given/);
    await expectExit([...base, '--max-upload', '0'], /--max-upload must be/);
    await expectExit([...base, '--max-upload', '1.5'], /--max-upload must be/);
    await expectExit([...base, '--port', 'abc'], /--port must be a whole number from 1 to 65535; got "abc"/);
    await expectExit([...base, '--port', '70000'], /--port must be a whole number from 1 to 65535/);
    await expectExit([...base, '--port'], /--port must be a whole number from 1 to 65535; no value was given/);
    await expectExit(['setup-code', '--dir', running.dir, '--origin', 'https://d.example.com', '--max-upload', 'x'], /--max-upload must be/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('setup-code reuses the address and upload limit serve last used with the same --dir', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'librepixel cli '));
  const port = await freePort();
  const child = spawn(process.execPath, [cli, 'serve', '--dir', dir, '--host', '127.0.0.1', '--port', String(port), '--max-upload', '123456'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    let log = '';
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk) => {
        log += chunk;
        if (/To show a QR code/.test(log)) resolve();
      });
      child.once('exit', () => reject(new Error(`serve exited early: ${log}`)));
    });
    const hint = log.match(/run librepixel (setup-code .*) --qr\./);
    assert.ok(hint, 'the log suggests a setup-code command');
    assert.equal(hint[1], `setup-code --dir '${dir}'`, 'a directory with spaces is quoted so the command can be pasted');

    const { stdout, stderr } = await librepixel(['setup-code', '--dir', dir]);
    assert.equal(stderr, '');
    const profile = decodeProfile(stdout.trim());
    assert.equal(profile.server, `127.0.0.1:${port}`);
    assert.equal(profile.limits.photoMaxBytes, 123456);

    const overridden = await librepixel(['setup-code', '--dir', dir, '--origin', 'https://e.example.com', '--max-upload', '42']);
    const custom = decodeProfile(overridden.stdout.trim());
    assert.equal(custom.server, 'e.example.com');
    assert.equal(custom.limits.photoMaxBytes, 42);

    await expectExit(['setup-code', '--dir', dir, '--port', '9999'], /pass --origin/);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('setup-code without a saved address asks for serve or --origin', async () => {
  await expectExit(['setup-code', '--dir', running.dir], /Run librepixel serve once with the same --dir, or pass --origin/);
});

test('help prints the usage; an unknown command prints it too and exits 1', async () => {
  for (const args of [['help'], ['--help'], ['serve', '--help']]) {
    const { stdout } = await librepixel(args);
    assert.match(stdout, /^Usage$/m);
    assert.match(stdout, /librepixel setup-code/);
  }
  await assert.rejects(librepixel(['nope']), (error) => {
    assert.ok(isExecFailure(error));
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Unknown command: nope/);
    assert.match(error.stderr, /^Usage$/m);
    return true;
  });
});

test('port in use: one-line message, exit code 1, no stack trace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'librepixel-cli-'));
  try {
    const port = new URL(running.origin).port;
    await assert.rejects(
      librepixel(['serve', '--dir', dir, '--host', '127.0.0.1', '--port', port]),
      (error) => {
        assert.ok(isExecFailure(error));
        assert.equal(error.code, 1);
        assert.match(error.stderr, new RegExp(`Port ${port} is already in use`));
        assert.doesNotMatch(error.stderr, /\n\s+at /, 'no stack trace');
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
