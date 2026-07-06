import { neon } from "@neondatabase/serverless";

type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;

// Prod: Neon's HTTP driver (one fetch per query, right for serverless).
// DEV_PG=1: plain TCP postgres for local verification — the Neon driver
// can't reach a localhost postgres.
function makeSql(): SqlTag {
  if (process.env.DEV_PG === "1") {
    let pool: import("pg").Pool | null = null;
    return async (strings, ...values) => {
      if (!pool) {
        const pg = await import("pg");
        const Pool = (pg.default ?? pg).Pool;
        pool = new Pool({ connectionString: process.env.DATABASE_URL });
      }
      const text = strings.reduce((acc, s, i) => acc + (i > 0 ? `$${i}` : "") + s, "");
      const res = await pool.query(text, values as unknown[]);
      return res.rows as Record<string, unknown>[];
    };
  }
  return neon(process.env.DATABASE_URL ?? "") as unknown as SqlTag;
}

export const sql = makeSql();

// Boot-style schema guard (no migrations): memoized per lambda instance, so
// the DDL round-trip is paid once per cold start, not per request.
let schemaReady: Promise<unknown> | null = null;
export function ensureSchema(): Promise<unknown> {
  schemaReady ??= sql`
    CREATE TABLE IF NOT EXISTS rooms (
      code text PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now(),
      claimed_at timestamptz,
      sender_seen timestamptz NOT NULL DEFAULT now(),
      receiver_seen timestamptz,
      sender_msgs jsonb NOT NULL DEFAULT '[]'::jsonb,
      receiver_msgs jsonb NOT NULL DEFAULT '[]'::jsonb
    )
  `.catch((err) => {
    schemaReady = null; // let the next request retry
    throw err;
  });
  return schemaReady;
}

/** Reap dead rooms: sender silent for 2+ minutes (left), or 24h absolute
 *  backstop. Runs opportunistically on room creation — no cron. */
export function sweepRooms(): Promise<unknown> {
  return sql`
    DELETE FROM rooms
    WHERE sender_seen < now() - interval '2 minutes'
       OR created_at < now() - interval '24 hours'
  `;
}

/** lowercase, trim, tolerate "word word word" / "word-word-word" input. */
export function normalizeCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const words = input.toLowerCase().trim().split(/[\s-]+/).filter(Boolean);
  if (words.length < 2 || words.length > 5) return null;
  if (!words.every((w) => /^[a-z]{1,12}$/.test(w))) return null;
  return words.join("-");
}
