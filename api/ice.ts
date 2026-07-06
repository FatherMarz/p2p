import type { VercelRequest, VercelResponse } from "@vercel/node";

// Mirrors Basecamp's ice-servers builder (basecamp server/src/index.ts).
// TURN is optional: unset env = STUN-only, which covers most home networks.
// The relay is advertised over both UDP and TCP so guests on UDP-blocking
// networks (corporate/guest wifi) still gather a usable relay candidate.
export default function handler(_req: VercelRequest, res: VercelResponse) {
  const servers: Array<{ urls: string | string[]; username?: string; credential?: string }> = [
    { urls: "stun:stun.l.google.com:19302" },
  ];
  const turnUrl = process.env.TURN_URL;
  if (turnUrl) {
    const base = turnUrl.replace(/\?.*$/, "");
    const urls = base.startsWith("turns:")
      ? [base] // TLS relay is already TCP; a transport param is redundant.
      : [`${base}?transport=udp`, `${base}?transport=tcp`];
    for (const extra of (process.env.TURN_EXTRA_URLS ?? "").split(",")) {
      if (extra.trim()) urls.push(extra.trim());
    }
    servers.push({
      urls,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ iceServers: servers });
}
