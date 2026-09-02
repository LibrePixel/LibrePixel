#!/usr/bin/env node

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const root = join(dirname(self), '..');

const DENYLIST: [RegExp, string][] = [
  [/google/i, 'Google'],
  [/\bgms\b/i, 'GMS'],
  [/android/i, 'Android'],
  [/(?<!libre)pixel/i, 'Pixel (other than LibrePixel)'],
  [/photos\.native/i, 'photos.native'],
  [/\bgservices\b/i, 'gservices'],
];

const ROOT_FILES = ['Dockerfile', '.dockerignore', 'package.json', 'tsconfig.json', 'tsconfig.build.json'];

async function targets(): Promise<string[]> {
  const files: string[] = [];
  const walk = async (relDir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(join(root, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = join(relDir, entry.name);
      if (entry.isDirectory()) await walk(rel);
      else files.push(rel);
    }
  };
  for (const dir of ['src', 'bin', 'test', 'scripts']) await walk(dir);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (extname(entry.name) === '.md' || ROOT_FILES.includes(entry.name)) files.push(entry.name);
  }
  return files.filter((rel) => rel !== relative(root, self));
}

let hits = 0;
for (const rel of await targets()) {
  const abs = join(root, rel);
  if (!(await stat(abs)).isFile()) continue;
  const lines = (await readFile(abs, 'utf8')).split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const [pattern, name] of DENYLIST) {
      if (pattern.test(line)) {
        console.error(`${rel}:${i + 1}  brand word "${name}": ${line.trim()}`);
        hits += 1;
      }
    }
  });
}

if (hits > 0) {
  console.error(
    `\ncheck:brand failed: ${hits} ${hits === 1 ? 'hit' : 'hits'}. The sources and docs must not name any third-party photo or cloud-album service or its private API.`,
  );
  process.exit(1);
}
console.log('check:brand passed: no brand words found.');
