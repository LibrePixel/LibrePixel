import type { OutgoingHttpHeaders } from 'node:http';
import type { Readable } from 'node:stream';

import { sameSecret } from './auth.ts';
import type { AuthMode } from './auth.ts';
import { qrSvg } from './qr.ts';
import { buildProfile, encodeProfile, setupLink } from './profile.ts';
import type { RateLimiter } from './ratelimit.ts';
import type { AssetDetail, Index, RecentAsset } from './sqlite.ts';

export interface BrowseRequest {
  headers: Record<string, string | string[] | undefined>;
}

export interface BrowseResponse extends NodeJS.WritableStream {
  writeHead(status: number, headers?: OutgoingHttpHeaders): this;
  destroy(error?: Error): unknown;
}

export interface BlobReader {
  openRead(hash: string): Promise<{ stream: Readable; size: number } | null>;
}

export interface BrowseContext {
  token: string;
  origin: string;
  index: Index;
  blobs: BlobReader;
  mode?: AuthMode;
  maxUploadBytes?: number;
  limiter?: RateLimiter;
  clientIp?: string;
  setupQR?: boolean;
  passwordHint?: string;
}

type ConnectContext = Pick<BrowseContext, 'origin' | 'token' | 'mode' | 'maxUploadBytes' | 'setupQR'> & {
  first?: boolean;
};

export function browseHandles(method: string | undefined, pathname: string): boolean {
  if (method !== 'GET') return false;
  return (
    pathname === '/' ||
    pathname === '/favicon.ico' ||
    pathname.startsWith('/photo/') ||
    pathname.startsWith('/v1/blob/')
  );
}

function browseAuthorized(req: BrowseRequest, token: string): boolean {
  const header = String(req.headers['authorization'] ?? '');
  if (header.startsWith('Bearer ')) return sameSecret(header.slice(7), token);
  if (header.startsWith('Basic ')) {
    let decoded = '';
    try {
      decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    } catch {
      return false;
    }
    const at = decoded.indexOf(':');
    const user = at >= 0 ? decoded.slice(0, at) : decoded;
    const pass = at >= 0 ? decoded.slice(at + 1) : '';
    return sameSecret(pass, token) || sameSecret(user, token);
  }
  return false;
}

const HEX64 = /^[0-9a-f]{64}$/;

function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

const esc = (text: unknown): string =>
  String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

function humanSize(bytes: number | null): string {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function humanTime(sec: number): string {
  const n = Number(sec) || 0;
  if (n <= 0) return '';
  const d = new Date(n * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCDate()}, ${d.getUTCFullYear()} at ${hh}:${mm} UTC`;
}

function monthOf(row: Pick<RecentAsset, 'captured_at' | 'uploaded_at'>): string {
  const sec = Number(row.captured_at) || Number(row.uploaded_at) || 0;
  if (sec <= 0) return 'Undated';
  const d = new Date(sec * 1000);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const items = (n: number): string => `${Number(n).toLocaleString('en-US')} ${Number(n) === 1 ? 'item' : 'items'}`;

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  tiff: 'image/tiff',
  dng: 'image/x-adobe-dng',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
};

function extensionOf(filename: string | null): string {
  const name = String(filename ?? '');
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : '';
}

function mimeFor(filename: string | null): string {
  const ext = String(filename ?? '').split('.').pop()?.toLowerCase() ?? '';
  return MIME[ext] ?? 'application/octet-stream';
}

const STYLE = `
:root { color-scheme: light dark;
  --bg: #F7F7F5; --surface: #FFFFFF; --ink: #1C1C1A; --ink-2: #3A3A36; --ink-3: #4A4A45;
  --muted: #6B6B66; --faint: #8A8A84; --line: #E6E6E1; --line-2: #EFEFEA; --field-line: #DADAD4;
  --dash: #CFCFC8; --chip: #EDEDE9; --tile: #ECECE8; --header-bg: rgba(247,247,245,.9);
  --accent: #0B6E5B; --accent-hover: #08523F; --on-accent: #FFFFFF; --link: #0B6E5B;
  --accent-soft: #E3F1EC; --accent-soft-ink: #0B5A4A;
  --warn: #8A4B0F; --warn-soft: #FBEEDB; --stage: #1C1C1A;
  --badge-bg: rgba(255,255,255,.85); --badge-ink: #1C1C1A; --scrim: rgba(0,0,0,.55); }
@media (prefers-color-scheme: dark) { :root {
  --bg: #141413; --surface: #1D1D1B; --ink: #EDEDE9; --ink-2: #D3D3CD; --ink-3: #BDBDB6;
  --muted: #9B9B94; --faint: #7E7E78; --line: #2E2E2B; --line-2: #272725; --field-line: #3B3B37;
  --dash: #46463F; --chip: #2A2A27; --tile: #222220; --header-bg: rgba(20,20,19,.88);
  --accent: #0F7F69; --accent-hover: #12917A; --on-accent: #FFFFFF; --link: #5CC8AD;
  --accent-soft: #12332C; --accent-soft-ink: #86D9C3;
  --warn: #E9A660; --warn-soft: #3A2A17; --stage: #0B0B0A;
  --badge-bg: rgba(20,20,19,.78); --badge-ink: #EDEDE9; --scrim: rgba(0,0,0,.65); } }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--ink);
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased; }
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
svg { display: block; flex-shrink: 0; }
h1, h2, p, ol, ul, dl, dd { margin: 0; }
code { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; padding: 1px 5px; border-radius: 5px;
  background: var(--chip); }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.logo-bg { fill: var(--accent); }
.wrap { max-width: 1200px; margin: 0 auto; padding-left: 24px; padding-right: 24px; }

.top { position: sticky; top: 0; z-index: 2; background: var(--header-bg); border-bottom: 1px solid var(--line);
  -webkit-backdrop-filter: saturate(1.4) blur(10px); backdrop-filter: saturate(1.4) blur(10px); }
.top.static { position: static; backdrop-filter: none; -webkit-backdrop-filter: none; background: transparent; }
.top .wrap { padding-top: 14px; padding-bottom: 14px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.brand { display: flex; align-items: center; gap: 10px; color: var(--ink); }
.brand:hover { text-decoration: none; }
.brand b { font-size: 17px; font-weight: 700; letter-spacing: -.01em; }
.brand.small { gap: 8px; }
.brand.small b { font-size: 15px; }
.count { font-size: 14px; color: var(--muted); font-variant-numeric: tabular-nums; }
.spacer { flex: 1; }
.pill { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 12px 0 8px;
  border-radius: 999px; background: var(--chip); color: var(--ink); font-size: 14px; font-weight: 500; }
.pill:hover { text-decoration: none; filter: brightness(.97); }

.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 46px;
  padding: 0 18px; border-radius: 12px; font: inherit; font-size: 15px; font-weight: 600; cursor: pointer;
  border: 1px solid transparent; background: var(--accent); color: var(--on-accent); text-align: center; }
.btn:hover { text-decoration: none; background: var(--accent-hover); }
.btn.secondary { background: var(--surface); border-color: var(--field-line); color: var(--ink); font-weight: 500; }
.btn.secondary:hover { background: var(--chip); }
.btn.block { display: flex; width: 100%; }
.btn.compact { min-height: 44px; border-radius: 10px; font-size: 14px; }

.connect { background: var(--surface); border: 1px solid var(--line); border-radius: 16px; }
.connect > summary { list-style: none; cursor: pointer; padding: 16px 20px; display: flex; align-items: center; gap: 12px; }
.connect > summary::-webkit-details-marker { display: none; }
.connect > summary .titles { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.connect > summary .titles b { font-size: 15px; font-weight: 600; }
.connect > summary .titles span { font-size: 13px; color: var(--muted); }
.connect > summary .chev { transition: transform .15s; }
.connect[open] > summary .chev { transform: rotate(180deg); }
.connect-body { padding: 4px 20px 20px; display: flex; gap: 24px; flex-wrap: wrap; align-items: flex-start; }
.qr { width: 196px; height: 196px; flex-shrink: 0; border-radius: 12px; overflow: hidden; background: #FFFFFF;
  border: 1px solid var(--line); }
.qr svg { width: 100%; height: 100%; }
.connect-info { flex: 1 1 320px; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
.steps { padding-left: 20px; font-size: 14px; line-height: 22px; color: var(--ink-2); }
.field { display: flex; gap: 8px; align-items: stretch; flex-wrap: wrap; }
.field input { flex: 1 1 240px; min-width: 0; height: 44px; padding: 0 12px; border-radius: 10px;
  border: 1px solid var(--field-line); background: var(--bg); color: var(--ink);
  font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; text-overflow: ellipsis; }
.field input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
.warn { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; line-height: 19px; color: var(--warn); }
.warn svg { margin-top: 1px; }

.first { max-width: 880px; margin: 0 auto; padding: 48px 24px; display: flex; flex-direction: column; gap: 20px; }
.first .intro { display: flex; flex-direction: column; gap: 6px; }
.first h1 { font-size: 30px; line-height: 36px; font-weight: 700; letter-spacing: -.02em; }
.first .intro p { font-size: 16px; line-height: 24px; color: var(--ink-3); }
.first .connect { border-radius: 20px; }
.first .connect-body { padding: 28px; gap: 32px; }
.first .qr { width: 228px; height: 228px; border-radius: 14px; }
.first .connect-info { gap: 16px; }
.first .steps { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 12px;
  font-size: 15px; counter-reset: step; }
.first .steps li { display: flex; gap: 12px; counter-increment: step; }
.first .steps li::before { content: counter(step); width: 24px; height: 24px; flex-shrink: 0; border-radius: 12px;
  background: var(--accent-soft); color: var(--accent-soft-ink); display: flex; align-items: center;
  justify-content: center; font-size: 13px; font-weight: 700; }
.nothing { display: flex; align-items: center; gap: 12px; padding: 18px 20px; border-radius: 16px;
  border: 1px dashed var(--dash); color: var(--muted); font-size: 14px; }

.library { padding-top: 24px; padding-bottom: 48px; display: flex; flex-direction: column; gap: 28px; }
.month { display: flex; flex-direction: column; gap: 12px; }
.month-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.month-head h2 { font-size: 20px; line-height: 28px; font-weight: 700; letter-spacing: -.01em; }
.month-head span { font-size: 14px; color: var(--muted); }
.grid { display: grid; gap: 8px; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
.tile { position: relative; aspect-ratio: 1; border-radius: 12px; overflow: hidden; display: block;
  background: var(--tile); color: var(--muted); }
.tile:hover { text-decoration: none; }
.tile:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.tile img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ph { display: none; }
.tile.noimg { border: 1px dashed var(--dash); }
.tile.noimg img { display: none; }
.tile.noimg .ph { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 6px; padding: 10px; text-align: center; }
.ph-name { font-size: 12px; line-height: 16px; word-break: break-all; color: var(--ink-3); }
.ph-note { font-size: 11px; color: var(--faint); }
.live { position: absolute; left: 8px; top: 8px; display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 7px; border-radius: 999px; background: var(--badge-bg); color: var(--badge-ink);
  font-size: 11px; font-weight: 700; letter-spacing: .04em; line-height: 16px; }
.more { font-size: 13px; color: var(--muted); text-align: center; }

.photo { padding-top: 24px; padding-bottom: 48px; display: flex; gap: 24px; flex-wrap: wrap; align-items: flex-start; }
.viewer { flex: 999 1 560px; min-width: 0; }
.frame { position: relative; border-radius: 16px; overflow: hidden; background: var(--stage);
  display: flex; align-items: center; justify-content: center; min-height: 240px; }
.frame img { display: block; max-width: 100%; max-height: min(78vh, 760px); object-fit: contain; }
.frame .live { left: 12px; top: 12px; padding: 3px 8px; }
.frame.noimg { background: var(--tile); border: 1px dashed var(--dash); min-height: min(62vh, 620px); }
.frame.noimg img, .frame.noimg .live { display: none; }
.frame.noimg .ph { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 24px;
  text-align: center; color: var(--ink-3); }
.ph-text { display: flex; flex-direction: column; gap: 4px; max-width: 360px; }
.ph-text b { font-size: 17px; font-weight: 600; color: var(--ink); }
.ph-text span { font-size: 14px; line-height: 21px; }
.frame .btn { min-height: 42px; font-size: 14px; padding: 0 16px; }
.details { flex: 1 1 320px; min-width: 0; display: flex; flex-direction: column; gap: 16px; }
.details .title { display: flex; flex-direction: column; gap: 4px; }
.details h1 { font-size: 22px; line-height: 28px; font-weight: 700; letter-spacing: -.01em; word-break: break-all; }
.details .title span { font-size: 14px; color: var(--muted); }
.actions { display: flex; flex-direction: column; gap: 8px; }
.meta { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; display: flex; flex-direction: column; }
.meta > div { display: flex; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--line-2); }
.meta > div:last-child { border-bottom: 0; }
.meta dt { width: 96px; flex-shrink: 0; font-size: 13px; color: var(--muted); }
.meta dd { min-width: 0; font-size: 14px; }
.mono { font: 12px/18px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--ink-2); word-break: break-all; }
.meta dd .mono { display: block; margin-top: 2px; }

.notice { min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 96px 16px 48px; }
.notice .brand { margin-bottom: 32px; }
.card { width: 100%; max-width: 440px; background: var(--surface); border: 1px solid var(--line); border-radius: 20px;
  padding: 32px; display: flex; flex-direction: column; gap: 20px; }
.badge { width: 48px; height: 48px; border-radius: 14px; display: flex; align-items: center; justify-content: center;
  background: var(--chip); color: var(--ink-3); }
.badge.accent { background: var(--accent-soft); color: var(--accent); }
.badge.warning { background: var(--warn-soft); color: var(--warn); }
.card .text { display: flex; flex-direction: column; gap: 8px; }
.card h1 { font-size: 24px; line-height: 30px; font-weight: 700; letter-spacing: -.015em; }
.card .text p { font-size: 15px; line-height: 23px; color: var(--ink-3); }
.hints { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 10px; font-size: 14px;
  line-height: 21px; color: var(--ink-2); counter-reset: hint; }
.hints li { display: flex; gap: 10px; counter-increment: hint; }
.hints li::before { content: counter(hint); width: 22px; height: 22px; flex-shrink: 0; border-radius: 11px;
  background: var(--chip); display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; }
.hints b { font-weight: 600; }

@media (max-width: 600px) {
  .wrap { padding-left: 16px; padding-right: 16px; }
  .library, .photo { padding-top: 16px; }
  .first { padding: 28px 16px; }
  .first h1 { font-size: 26px; line-height: 32px; }
  .first .connect-body { padding: 20px; gap: 20px; }
  .connect > summary { padding: 14px 16px; }
  .connect-body { padding: 4px 16px 16px; }
  .qr, .first .qr { width: 100%; max-width: 260px; height: auto; aspect-ratio: 1; margin: 0 auto; }
  .grid { grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 4px; }
  .tile { border-radius: 8px; }
  .frame.noimg { min-height: 320px; }
  .notice { padding-top: 48px; }
  .card { padding: 24px; }
}
`;

const CSS = STYLE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\n{2,}/g, '\n');

const icon = (size: number, body: string, width = 1.8): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
  `stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICON = {
  image: (size: number, width?: number) =>
    icon(size, '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="M4 18l5-5 4 4 3-3 4 4"/>', width),
  qr: () =>
    icon(20, '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>' +
      '<rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>'),
  chevron: () => icon(16, '<path d="M6 9l6 6 6-6"/>', 2),
  back: () => icon(16, '<path d="M15 6l-6 6 6 6"/>', 2.2),
  warn: () => icon(16, '<path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17v.01"/>', 1.9),
  download: () => icon(17, '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>', 2),
  video: () => icon(17, '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3"/>', 1.9),
  live: () => icon(11, '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7"/>', 2.2),
  lock: () => icon(24, '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  clock: () => icon(24, '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  missing: () =>
    icon(24, '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9.5 10a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.2M12 17v.01"/>'),
};

const logo = (size: number): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 28 28" aria-hidden="true">` +
  `<rect class="logo-bg" width="28" height="28" rx="8"/>` +
  `<rect x="7" y="7" width="6" height="6" rx="1.5" fill="#FFFFFF"/>` +
  `<rect x="15" y="7" width="6" height="6" rx="1.5" fill="#FFFFFF" opacity=".55"/>` +
  `<rect x="7" y="15" width="6" height="6" rx="1.5" fill="#FFFFFF" opacity=".55"/>` +
  `<rect x="15" y="15" width="6" height="6" rx="1.5" fill="#FFFFFF"/></svg>`;

const brand = (small = false): string =>
  `<a class="brand${small ? ' small' : ''}" href="/">${logo(small ? 22 : 28)}<b>LibrePixel</b></a>`;

const liveBadge = `<span class="live" title="Live Photo with video">${ICON.live()}LIVE</span>`;

function shell(title: string, body: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="color-scheme" content="light dark">` +
    `<title>${esc(title)}</title><style>${CSS}</style></head>` +
    `<body>${body}</body></html>`
  );
}

interface Notice {
  title: string;
  badge: string;
  tone?: string;
  body: string;
  extra?: string;
  action?: string;
}

function noticePage({ title, badge, tone = '', body, extra = '', action = 'Back to all photos' }: Notice): string {
  return shell(
    `${title} · LibrePixel`,
    `<div class="notice">${brand()}<main class="card">` +
      `<div class="badge${tone ? ` ${tone}` : ''}">${badge}</div>` +
      `<div class="text"><h1>${esc(title)}</h1>${body}</div>${extra}` +
      `<a class="btn block" href="/">${esc(action)}</a></main></div>`,
  );
}

const TOKEN_FILE_HINT =
  `this server's token. Its operator can find it in the <code>token</code> file in the data directory.`;

const passwordPage = (hint?: string): string =>
  noticePage({
    title: 'Password required',
    badge: ICON.lock(),
    tone: 'accent',
    body: `<p>You need a password to view the photos on this server.</p>`,
    extra:
      `<ul class="hints"><li><span><b>Username:</b> anything you like.</span></li>` +
      `<li><span><b>Password:</b> ${hint === undefined ? TOKEN_FILE_HINT : esc(hint)}</span></li></ul>`,
    action: 'Try again',
  });

const PASSWORD_PAGE = passwordPage();

const TOO_MANY_PAGE = noticePage({
  title: 'Too many attempts',
  badge: ICON.clock(),
  tone: 'warning',
  body: `<p>That password was wrong too many times. Wait a minute, then try again.</p>`,
  action: 'Try again',
});

const NOT_FOUND_PAGE = noticePage({
  title: 'File not found',
  badge: ICON.missing(),
  body: `<p>This file doesn't exist on this server. The link may be out of date.</p>`,
});

const PHOTO_NOT_FOUND_PAGE = noticePage({
  title: 'Photo not found',
  badge: ICON.missing(),
  body: `<p>This photo isn't on this server. The link may be out of date.</p>`,
});

const FALLBACK = `onerror="this.closest('.tile,.frame').classList.add('noimg')"`;

const COPY_SCRIPT = `<script>
document.querySelectorAll('[data-copy]').forEach(function (button) {
  var field = document.getElementById(button.getAttribute('data-copy'));
  if (!field) return;
  button.hidden = false;
  var timer;
  var done = function (ok) {
    button.textContent = ok ? 'Copied' : 'Select and copy';
    clearTimeout(timer);
    timer = setTimeout(function () { button.textContent = 'Copy'; }, 2000);
  };
  button.addEventListener('click', function () {
    field.focus();
    field.setSelectionRange(0, field.value.length);
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    if (ok || !navigator.clipboard) return done(ok);
    navigator.clipboard.writeText(field.value).then(function () { done(true); }, function () { done(false); });
  });
});
</script>`;

function connectBody(ctx: ConnectContext): { hasQR: boolean; html: string } {
  const profile = buildProfile(ctx.origin, ctx.token, {
    mode: ctx.mode,
    maxUploadBytes: ctx.maxUploadBytes,
  });
  const code = encodeProfile(profile);
  const link = setupLink(code);
  const svg = ctx.setupQR === false ? '' : qrSvg(link, { scale: 4, margin: 3 });
  const second = svg
    ? ctx.first
      ? `Scan this QR code with your phone's camera, or copy the connection info and paste it into the app.`
      : `Scan this QR code, or copy the connection info below and paste it.`
    : `Copy the connection info below and paste it into the app.`;
  return {
    hasQR: Boolean(svg),
    html:
      `<div class="connect-body">${svg ? `<div class="qr">${svg}</div>` : ''}` +
      `<div class="connect-info">` +
      `<ol class="steps"><li><span>In the app, add a LibrePixel destination.</span></li>` +
      `<li><span>${second}</span></li></ol>` +
      `<div class="field"><label class="sr" for="connection-info">Connection info</label>` +
      `<input id="connection-info" readonly spellcheck="false" autocomplete="off" value="${esc(code)}" ` +
      `onfocus="this.select()">` +
      `<button class="btn compact" type="button" data-copy="connection-info" hidden>Copy</button></div>` +
      `<p class="warn">${ICON.warn()}<span>Anyone with this connection info can access this server. ` +
      `Share it only with people you trust.</span></p>` +
      `</div></div>`,
  };
}

function libraryHeader(count: number): string {
  return (
    `<header class="top"><div class="wrap">${brand()}` +
    `<span class="count">${items(count)}</span>` +
    `</div></header>`
  );
}

function tile(row: RecentAsset): string {
  const ref = esc(row.ref);
  const name = esc(row.filename || row.ref);
  return (
    `<a class="tile" href="/photo/${ref}" title="${name}">` +
    `<img loading="lazy" src="/v1/blob/${ref}" alt="${name}" ${FALLBACK}>` +
    `<span class="ph">${ICON.image(26, 1.6)}<span class="ph-name">${name}</span>` +
    `<span class="ph-note">No preview</span></span>` +
    `${row.paired_hash ? liveBadge : ''}</a>`
  );
}

function gridPage(ctx: BrowseContext, rows: RecentAsset[], count: number): string {
  if (rows.length === 0) {
    const connect = connectBody({ ...ctx, first: true });
    return shell(
      'LibrePixel',
      libraryHeader(count) +
        `<main class="first"><div class="intro"><h1>Connect the app</h1>` +
        `<p>This server is running. Connect the app to it, and backed-up photos will show up here.</p></div>` +
        `<section class="connect">${connect.html}</section>` +
        `<div class="nothing">${ICON.image(20, 1.6)}<span>No photos yet.</span></div></main>` +
        COPY_SCRIPT,
    );
  }

  const groups: { month: string; rows: RecentAsset[] }[] = [];
  for (const row of rows) {
    const month = monthOf(row);
    let group = groups.at(-1);
    if (group?.month !== month) {
      group = { month, rows: [] };
      groups.push(group);
    }
    group.rows.push(row);
  }
  const truncated = rows.length < count;
  const sections = groups
    .map((group, at) => {
      const partial = truncated && at === groups.length - 1;
      return (
        `<section class="month"><div class="month-head"><h2>${esc(group.month)}</h2>` +
        (partial ? '' : `<span>${items(group.rows.length)}</span>`) +
        `</div><div class="grid">${group.rows.map(tile).join('')}</div></section>`
      );
    })
    .join('');

  const connect = connectBody(ctx);
  const panel =
    `<details class="connect"><summary>${ICON.qr()}` +
    `<span class="titles"><b>Connect the app</b><span>` +
    `${connect.hasQR ? 'Scan the QR code or paste the connection info' : 'Paste the connection info'}` +
    `</span></span>${ICON.chevron()}</summary>${connect.html}</details>`;

  return shell(
    'LibrePixel',
    libraryHeader(count) +
      `<main class="wrap library">${panel}${sections}` +
      (truncated
        ? `<p class="more">Showing the latest ${items(rows.length)} of ${Number(count).toLocaleString('en-US')}.</p>`
        : '') +
      `</main>` +
      COPY_SCRIPT,
  );
}

function photoPage(row: AssetDetail): string {
  const ref = esc(row.ref);
  const name = esc(row.filename || row.ref);
  const ext = esc(extensionOf(row.filename).toUpperCase());
  const download = `/v1/blob/${ref}?download=1`;
  const taken = humanTime(row.captured_at);
  const uploaded = humanTime(row.uploaded_at);
  const paired = row.paired_hash
    ? `<a class="btn block secondary" href="/v1/blob/${esc(row.paired_hash)}?download=1">` +
      `${ICON.video()}Download Live Photo video</a>`
    : '';
  const meta: string = [
    ['Size', esc(humanSize(row.size))],
    ['Uploaded', uploaded ? esc(uploaded) : '—'],
    row.paired_hash
      ? ['Live video', `${esc(humanSize(row.paired_size))}<span class="mono">${esc(row.paired_hash)}</span>`]
      : null,
    ['SHA-256', `<span class="mono">${ref}</span>`],
  ]
    .filter((entry): entry is string[] => entry !== null)
    .map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`)
    .join('');

  const body =
    `<header class="top static"><div class="wrap">` +
    `<a class="pill" href="/">${ICON.back()}All photos</a><span class="spacer"></span>${brand(true)}` +
    `</div></header>` +
    `<main class="wrap photo">` +
    `<div class="viewer"><div class="frame">` +
    `<img src="/v1/blob/${ref}" alt="${name}" ${FALLBACK}>${row.paired_hash ? liveBadge : ''}` +
    `<div class="ph">${ICON.image(44, 1.4)}<div class="ph-text">` +
    `<b>${ext ? `No preview for ${ext}` : 'No preview'}</b>` +
    `<span>Your browser can't display this format. Download the original to view it.</span></div>` +
    `<a class="btn secondary" href="${download}">Download original</a></div>` +
    `</div></div>` +
    `<aside class="details"><div class="title"><h1>${name}</h1>` +
    `<span>${taken ? `Taken ${esc(taken)}` : 'Capture time unknown'}</span></div>` +
    `<div class="actions"><a class="btn block" href="${download}">${ICON.download()}Download original</a>${paired}</div>` +
    `<dl class="meta">${meta}</dl></aside></main>`;
  return shell(`${row.filename || row.ref} · LibrePixel`, body);
}

function send(res: BrowseResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
}

export async function handleBrowse(
  req: BrowseRequest,
  res: BrowseResponse,
  url: URL,
  ctx: BrowseContext,
): Promise<void> {
  const path = url.pathname;

  if (path === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }

  if (!browseAuthorized(req, ctx.token)) {
    if (ctx.limiter && !ctx.limiter.check(`browse:${ctx.clientIp ?? 'local'}`)) {
      send(res, 429, TOO_MANY_PAGE, { 'retry-after': '60' });
      return;
    }
    send(res, 401, ctx.passwordHint === undefined ? PASSWORD_PAGE : passwordPage(ctx.passwordHint), { 'www-authenticate': 'Basic realm="LibrePixel", charset="UTF-8"' });
    return;
  }

  if (path === '/') {
    const [rows, count] = await Promise.all([ctx.index.recent(), ctx.index.countAssets()]);
    send(res, 200, gridPage(ctx, rows, count));
    return;
  }

  if (path.startsWith('/photo/')) {
    const ref = decodeSegment(path.slice('/photo/'.length));
    const row = ref !== null && HEX64.test(ref) ? await ctx.index.assetByRef(ref) : null;
    if (!row) {
      send(res, 404, PHOTO_NOT_FOUND_PAGE);
      return;
    }
    send(res, 200, photoPage(row));
    return;
  }

  if (path.startsWith('/v1/blob/')) {
    await sendBlob(req, res, url, ctx);
    return;
  }

  send(res, 404, NOT_FOUND_PAGE);
}

async function sendBlob(req: BrowseRequest, res: BrowseResponse, url: URL, ctx: BrowseContext): Promise<void> {
  const hash = decodeSegment(url.pathname.slice('/v1/blob/'.length));
  if (hash === null || !HEX64.test(hash)) {
    send(res, 400, NOT_FOUND_PAGE);
    return;
  }

  const asset = await ctx.index.assetForBlob(hash);
  if (!asset) {
    send(res, 404, NOT_FOUND_PAGE);
    return;
  }

  const isPaired = asset.paired_hash === hash;
  const base = (asset.filename || asset.ref).replace(/\.[^.]+$/, '');
  const filename = isPaired ? `${base}.mov` : asset.filename || `${hash}`;
  const mime = isPaired ? 'video/quicktime' : mimeFor(asset.filename);

  const headers: Record<string, string> = {
    'content-type': mime,
    'cache-control': 'private, max-age=3600',
    'x-content-type-options': 'nosniff',
  };
  if (url.searchParams.get('download') === '1') {
    headers['content-disposition'] = contentDisposition(filename);
  }

  const opened = await ctx.blobs.openRead(hash);
  if (!opened) {
    send(res, 404, NOT_FOUND_PAGE);
    return;
  }
  headers['content-length'] = String(opened.size);

  try {
    res.writeHead(200, headers);
  } catch (error) {
    opened.stream.destroy();
    throw error;
  }
  opened.stream.on('error', () => res.destroy());
  opened.stream.pipe(res);
}

function contentDisposition(filename: string): string {
  const fallback = filename.replace(/(?:[^ -~]|["\\])+/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
