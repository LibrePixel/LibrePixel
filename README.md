# LibrePixel

A self-hosted photo backup server with zero runtime dependencies.

LibrePixel receives originals from a compatible backup app on your phone and keeps them on your own disk. It is a single Node.js process: the standard library only, SQLite from `node:sqlite`, no build step needed to run it.

## Features

- **Content-addressed storage.** Every file is stored once under its SHA-256. Uploads are verified against the declared size and checksum before they are kept, and duplicates are skipped.
- **Single-use upload IDs.** Each upload gets a single-use upload ID that expires after 30 minutes. Expired uploads and their unreferenced bytes are cleaned up automatically (at startup and every 10 minutes).
- **Integrity-aware dedup.** A file only counts as backed up while its bytes are actually on disk with the right size. If a file goes missing or is truncated, the app is told to upload it again.
- **Live Photos.** A still and its paired video are committed together as one item. A still that was stored alone can gain its video later.
- **Browse page.** A password-protected web page lists the latest 200 items grouped by month, with a detail page per photo, original downloads, and a separate download for a Live Photo's video.
- **Setup QR code and connection info.** The web page and the CLI show the connection info as text, as a link, or as a QR code (terminal or SVG).
- **Two auth modes.**
  - `bearer` (default): the app sends the server token directly.
  - `exchange`: the app exchanges the token for a short-lived (1 hour) session token, and devices can be bound to a signing key so that the token alone is no longer enough.
- **Device binding.** In `exchange` mode, the first device registers its public key with the token alone; after that, new devices must be approved by a signature from an already-bound device. Bound devices can be listed and unbound from the CLI.
- **Upload limits.** A per-file size cap (default 8 GiB) is enforced on the declared size, on `Content-Length`, and on the bytes actually received.
- **Rate limiting.** Auth, registration and wrong browse passwords are limited to 30 attempts per minute per client address.

## Quick start

Requires Node.js 22.18 or later (TypeScript runs directly, no install needed).

### From source

```sh
git clone <this repository> librepixel
cd librepixel
node bin/librepixel.ts serve
```

`npm start` does the same. Data goes to `./data` unless you pass `--dir`.

On startup it prints the address phones should use, the connection info, and how to open the browse page. The address defaults to `http://<this machine's LAN address>:8788`; pass `--origin` if phones reach it some other way (a domain, a reverse proxy, a container port mapping).

### Docker

```sh
docker build -t librepixel .
docker run -d --name librepixel \
  -p 8788:8788 \
  -v librepixel-data:/data \
  -e LIBREPIXEL_ORIGIN=https://photos.example.com \
  librepixel
```

Inside the container data lives in `/data` and the server listens on `0.0.0.0:8788`. Always set `LIBREPIXEL_ORIGIN` to the address phones use, because the container cannot know it. `LIBREPIXEL_TRUST_PROXY` and `LIBREPIXEL_AUTH` are also read from the environment.

The connection info is printed to `docker logs librepixel`. To print it again:

```sh
docker exec librepixel node bin/librepixel.ts setup-code --dir /data
```

## Connect the app

1. Open the server's address in a browser and sign in (see [Security](#security)).
2. Use the **Connect the app** panel. When there are no photos yet, it fills the whole page.
3. In a compatible backup app, add a LibrePixel destination and scan the QR code, or copy the connection info and paste it.

Without a browser, print the connection info with the CLI:

```sh
node bin/librepixel.ts setup-code            # text, starts with lp1. or lp1z.
node bin/librepixel.ts setup-code --link     # librepixel://setup?code=...
node bin/librepixel.ts setup-code --qr       # QR code in the terminal
node bin/librepixel.ts setup-code --svg qr.svg
```

**The connection info is a secret, like a password.** It contains the server token, so anyone who has it can access this server. It also appears in the startup log, so share logs only with people you trust.

## CLI reference

```
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
```

| Environment variable | Same as |
| --- | --- |
| `LIBREPIXEL_ORIGIN=https://...` | `--origin` |
| `LIBREPIXEL_TRUST_PROXY=1` | `--trust-proxy` |
| `LIBREPIXEL_AUTH=exchange` | `--auth` |

Flags take precedence over the environment.

- `--max-upload` defaults to 8 GiB (8589934592 bytes).
- `--origin` defaults to `http://<host>:<port>`, using the LAN address when `--host` is `0.0.0.0`.
- `--auth` is remembered in the data directory, so later runs keep the last mode unless you pass it again.
- `--trust-proxy` makes rate limiting use the rightmost `X-Forwarded-For` address. Only set it when a reverse proxy sets that header.
- `devices` and `unbind` apply to `exchange` mode; in `bearer` mode no devices are bound.

## Security

- **Use HTTPS for internet access.** LibrePixel speaks plain HTTP. Put it behind an HTTPS reverse proxy, set `--origin` to the public `https://` address, and pass `--trust-proxy`. Plain HTTP is only for a trusted local network.
- **The token is the master secret.** It is generated on first start and stored in `<dir>/token` (mode 600). It is the browse password and is inside the connection info. To revoke it, stop the server, delete the file, start again, and reconnect the app with the new connection info.
- **Browse page.** Sign in with the token as the password. The page sets a signed, HttpOnly, SameSite=Lax session cookie for 30 days (Secure when the origin is https); changing the token signs everyone out. Scripts can still send the token as Bearer or Basic auth. Wrong guesses are rate limited.
- **Device keys.** With `--auth exchange`, the token alone cannot upload; it must be exchanged for a 1-hour session. After the first device binds a key, the exchange also needs a signature from a bound device, and the session token is returned encrypted to that device. Use `librepixel devices` to list bound keys and `librepixel unbind <issuer>` (or `all`) to remove them. After `unbind all`, the next device can bind with just the connection info.

What is stored in the data directory:

| Path | Contents |
| --- | --- |
| `token` | Server token (secret) |
| `auth` | Last auth mode used by `serve` |
| `server.json` | Address and upload limit last used by `serve`, read by `setup-code` |
| `index.db` | SQLite index: items and filenames, pending uploads, bound device keys, sessions |
| `blobs/<ab>/<sha256>` | Original files, named by their SHA-256 |
| `tmp/` | Partial uploads; cleared on startup |

Back up the whole directory to keep your library. Files in `blobs/` have no extension; their names and capture times are in `index.db`.

## Protocol overview

The connection info is `lp1.` + base64url(JSON) or `lp1z.` + base64url(raw-deflate(JSON)); the link form is `librepixel://setup?code=<code>`. The JSON lists the endpoint URLs, header names, auth settings, size limits and credential. See [`src/profile.ts`](src/profile.ts).

Control endpoints take `POST` with a protobuf body and return protobuf. Errors are `text/plain` as `code: message` (see [`src/errors.ts`](src/errors.ts)).

**Auth** ([`src/auth.ts`](src/auth.ts), [`src/binding.ts`](src/binding.ts))

- `bearer` mode: send `Authorization: Bearer <token>`.
- `exchange` mode: form-encoded requests, `Key=value` line responses.
  - `POST /v1/register` with `Authorization: Bearer <token>` and `public_key` (base64url P-256 SPKI), optional `label`, and, once any key is bound, an `assertion` from a bound device. Returns `Issuer=...`.
  - `POST /v1/auth` with `Token=<token>` and `assertion`: an ES256 JWT with `iss` (the issuer), `aud` (`<origin>/v1/auth`), `namespace`, a fresh `iat`, and an `ephemeral_key` to encrypt the reply to. Returns `Auth`, `Expiry` and `TokenEncrypted=1`. With no keys bound, the `assertion` may be omitted and `Auth` is returned in plain text.
  - Then send `Authorization: Bearer <Auth>` until `Expiry`.

**Upload** ([`src/handler.ts`](src/handler.ts))

1. `POST /v1/have`: list of SHA-256 digests; returns the ones already stored intact.
2. `POST /v1/find`: one SHA-256; returns the item's ref if it is stored.
3. `POST /v1/upload-token`: declared size, with header `X-Content-Hash: sha256=<base64>`. Returns `X-Upload-Id` and `X-Upload-Url` headers, or 413 over the limit.
4. `PUT /v1/upload?upload_id=<id>`: the raw bytes. The upload ID is single-use and expires in 30 minutes. Returns the size and upload ID, which the client echoes back in the commit.
5. `POST /v1/commit`: the echoed upload response, filename, SHA-256, upload and capture times (Unix seconds), and optionally a paired video (echoed upload response, SHA-256, still time in ns). Returns the ref, which is the original's SHA-256 in hex.

**Other**

- `GET /v1/health` returns `ok` without auth.
- `GET /`, `GET /photo/<sha256>`, `GET /v1/blob/<sha256>[?download=1]`: the browse page and original files, using the session cookie from `GET`/`POST /login` (`password=<token>`), or the token as Basic or Bearer auth. `POST /logout` clears the cookie ([`src/browse.ts`](src/browse.ts)).

The protobuf field numbers are in [`src/handler.ts`](src/handler.ts); the encoder and decoder are in [`src/protobuf.ts`](src/protobuf.ts). The tests in [`test/`](test) cover each flow end to end, and [`test/support.ts`](test/support.ts) has the client-side helpers they use.

## Development

```sh
npm install           # dev dependencies (TypeScript, Node types); also builds dist/
npm test              # brand check, type check, then the test suite
npm run check:brand   # brand check only
npm run typecheck
npm run build         # compile to dist/
```

## License

MIT. See [LICENSE](LICENSE).
