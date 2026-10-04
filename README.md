# p2p

One-time passphrase, browser-to-browser file transfer. Live at [file.modul4r.com](https://file.modul4r.com).

Sender picks a file and gets a three-word passphrase. Receiver types it in, accepts, and the file streams directly between the two browsers over a WebRTC data channel. Nothing is uploaded. The only server-side state is the handshake mailbox (offer, answer, ICE) in Neon, removed minutes after the sender leaves.

Transfers use a negotiated data channel with 256KB chunks and backpressure. Desktop Chromium streams straight to disk (File System Access API). Other browsers fall back to in-memory assembly, capped at 250MB.

## Stack

- Vite, React, TypeScript, Tailwind (static single-page app)
- Vercel serverless functions in `api/` + Neon Postgres as a polling signaling mailbox
- Optional TURN relay, set with the `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` / `TURN_EXTRA_URLS` environment variables (STUN only without them)

## Development

```bash
npm install
docker run -d --name p2p-pg -e POSTGRES_PASSWORD=p2p -e POSTGRES_DB=p2p -p 127.0.0.1:5544:5432 postgres:16-alpine
DEV_PG=1 DATABASE_URL=postgres://postgres:p2p@127.0.0.1:5544/p2p npx tsx scripts/dev-api.ts   # api on :3210
npm run dev                                                                                    # vite on :5175, proxies /api
node scripts/e2e.mjs            # two-browser transfer + hash check
node scripts/e2e-lifecycle.mjs  # disposable-passphrase semantics
```

Built by Marcello Delcaro, AI-assisted.
