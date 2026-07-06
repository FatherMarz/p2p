# p2p

One-time passphrase, browser-to-browser file transfer. Live at [p2p.modul4r.com](https://p2p.modul4r.com).

Sender picks a file and gets a three-word passphrase. Receiver types it in, accepts, and the file streams directly between the two browsers over a WebRTC data channel. Nothing is uploaded; the only server-side state is the handshake mailbox (offer/answer/ICE) in Neon, reaped minutes after the sender leaves.

The transfer engine is ported from Basecamp's P2P file transfer: negotiated data channel, 256KB chunks with backpressure, streams straight to disk on desktop Chromium (File System Access API), 250MB in-memory fallback elsewhere.

## Stack

- Vite + React + TS + Tailwind (static SPA)
- Vercel serverless functions in `api/` + Neon Postgres as a polling signaling mailbox
- Optional TURN relay via `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` / `TURN_EXTRA_URLS` env vars (STUN-only without them)

## Dev

```bash
npm install
docker run -d --name p2p-pg -e POSTGRES_PASSWORD=p2p -e POSTGRES_DB=p2p -p 127.0.0.1:5544:5432 postgres:16-alpine
DEV_PG=1 DATABASE_URL=postgres://postgres:p2p@127.0.0.1:5544/p2p npx tsx scripts/dev-api.ts   # api on :3210
npm run dev                                                                                    # vite on :5175, proxies /api
node scripts/e2e.mjs            # two-browser transfer + hash check
node scripts/e2e-lifecycle.mjs  # disposable-passphrase semantics
```
