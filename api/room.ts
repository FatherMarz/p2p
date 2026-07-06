import type { VercelRequest, VercelResponse } from "@vercel/node";
import { randomInt } from "node:crypto";
import { sql, ensureSchema, sweepRooms, normalizeCode } from "./_lib/db.js";
import { WORDS } from "./_lib/words.js";

function generateCode(): string {
  return `${WORDS[randomInt(WORDS.length)]}-${WORDS[randomInt(WORDS.length)]}-${WORDS[randomInt(WORDS.length)]}`;
}

/** sendBeacon posts opaque bodies (often text/plain), so the body may arrive
 *  as a string, a parsed object, or a Buffer depending on content type. */
function parseBody(req: VercelRequest): Record<string, unknown> {
  const body = req.body;
  if (body && typeof body === "object" && !Buffer.isBuffer(body)) {
    return body as Record<string, unknown>;
  }
  try {
    return JSON.parse(Buffer.isBuffer(body) ? body.toString("utf8") : String(body ?? ""));
  } catch {
    return {};
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  await ensureSchema();
  const body = parseBody(req);

  if (body.action === "create") {
    await sweepRooms();
    // Retry on the astronomically unlikely collision with a live room.
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = generateCode();
      const rows = await sql`
        INSERT INTO rooms (code) VALUES (${code})
        ON CONFLICT (code) DO NOTHING
        RETURNING code
      `;
      if (rows.length > 0) return res.status(200).json({ code });
    }
    return res.status(500).json({ error: "could not allocate a code" });
  }

  if (body.action === "close") {
    const code = normalizeCode(body.code);
    if (code) await sql`DELETE FROM rooms WHERE code = ${code}`;
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: "bad action" });
}
