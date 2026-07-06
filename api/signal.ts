import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sql, ensureSchema, normalizeCode } from "./_lib/db.js";

/** A sender whose poll heartbeat is older than this is treated as gone —
 *  the code is dead and a claim must fail. Senders poll every second while
 *  waiting, so 12s tolerates a flaky network without lying to the receiver. */
const SENDER_FRESH_MS = 12_000;

/** Signals are small JSON (SDP ~5-10KB, candidates ~200B). Anything bigger
 *  is not a WebRTC handshake. */
const MAX_APPEND_BYTES = 64 * 1024;
const MAX_MSGS_PER_ROOM = 200;

type RoomRow = {
  claimed_at: string | null;
  sender_seen: string;
  receiver_seen: string | null;
  msgs: unknown[];
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  await ensureSchema();

  // --- GET: poll the other side's mailbox (doubles as our heartbeat) --------
  if (req.method === "GET") {
    const code = normalizeCode(req.query.code);
    const role = req.query.role === "receive" ? "receive" : "send";
    const after = Math.max(0, Number(req.query.after) || 0);
    if (!code) return res.status(400).json({ error: "bad code" });

    const rows = (
      role === "send"
        ? await sql`
            UPDATE rooms SET sender_seen = now()
            WHERE code = ${code}
            RETURNING claimed_at, sender_seen, receiver_seen, receiver_msgs AS msgs
          `
        : await sql`
            UPDATE rooms SET receiver_seen = now()
            WHERE code = ${code}
            RETURNING claimed_at, sender_seen, receiver_seen, sender_msgs AS msgs
          `
    ) as RoomRow[];
    if (rows.length === 0) return res.status(404).json({ error: "gone" });
    const room = rows[0];
    const senderSeenMs = Date.now() - new Date(room.sender_seen).getTime();
    return res.status(200).json({
      msgs: room.msgs.slice(after),
      total: room.msgs.length,
      claimed: room.claimed_at !== null,
      senderAlive: senderSeenMs < SENDER_FRESH_MS,
    });
  }

  // --- POST: claim a room, or append signals to our mailbox -----------------
  if (req.method === "POST") {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const code = normalizeCode(body.code);
    if (!code) return res.status(400).json({ error: "bad code" });

    if (body.action === "claim") {
      // One-time: first claim locks the room. Distinguish "no such/expired
      // code" from "someone already used it" so the UI can say the right thing.
      const claimed = await sql`
        UPDATE rooms SET claimed_at = now(), receiver_seen = now()
        WHERE code = ${code}
          AND claimed_at IS NULL
          AND sender_seen > now() - make_interval(secs => ${SENDER_FRESH_MS / 1000})
        RETURNING code
      `;
      if (claimed.length > 0) return res.status(200).json({ ok: true });
      const existing = await sql`
        SELECT claimed_at, sender_seen FROM rooms WHERE code = ${code}
      `;
      if (existing.length === 0) return res.status(404).json({ error: "dead" });
      if (existing[0].claimed_at !== null) return res.status(409).json({ error: "claimed" });
      return res.status(404).json({ error: "dead" }); // sender stopped heartbeating
    }

    if (body.action === "append") {
      const role = body.role === "receive" ? "receive" : "send";
      const msgs = Array.isArray(body.msgs) ? body.msgs : [];
      if (msgs.length === 0) return res.status(200).json({ ok: true });
      const payload = JSON.stringify(msgs);
      if (payload.length > MAX_APPEND_BYTES) return res.status(413).json({ error: "too big" });
      const ok =
        msgs.length <= 20 &&
        msgs.every(
          (m) =>
            m &&
            typeof m === "object" &&
            typeof (m as { rev?: unknown }).rev === "number" &&
            ["offer", "answer", "candidate"].includes(String((m as { kind?: unknown }).kind)),
        );
      if (!ok) return res.status(400).json({ error: "bad msgs" });

      const rows =
        role === "send"
          ? await sql`
              UPDATE rooms
              SET sender_msgs = sender_msgs || ${payload}::jsonb, sender_seen = now()
              WHERE code = ${code} AND jsonb_array_length(sender_msgs) < ${MAX_MSGS_PER_ROOM}
              RETURNING code
            `
          : await sql`
              UPDATE rooms
              SET receiver_msgs = receiver_msgs || ${payload}::jsonb, receiver_seen = now()
              WHERE code = ${code} AND jsonb_array_length(receiver_msgs) < ${MAX_MSGS_PER_ROOM}
              RETURNING code
            `;
      if (rows.length === 0) return res.status(404).json({ error: "gone" });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "bad action" });
  }

  return res.status(405).json({ error: "method" });
}
