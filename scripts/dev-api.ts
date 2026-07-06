// Local stand-in for Vercel's api/ runtime: mounts the three handlers on
// node http with just enough VercelRequest/VercelResponse shim to run them.
// Usage: DEV_PG=1 DATABASE_URL=postgres://... npx tsx scripts/dev-api.ts
import http from "node:http";
import { URL } from "node:url";
import roomHandler from "../api/room.js";
import signalHandler from "../api/signal.js";
import iceHandler from "../api/ice.js";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const routes: Record<string, (req: VercelRequest, res: VercelResponse) => unknown> = {
  "/api/room": roomHandler,
  "/api/signal": signalHandler,
  "/api/ice": iceHandler as unknown as (req: VercelRequest, res: VercelResponse) => unknown,
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const handler = routes[url.pathname];
  if (!handler) {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown = raw;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      // keep raw string, like Vercel does for non-JSON content types
    }
    const vreq = req as unknown as VercelRequest;
    (vreq as { query: Record<string, string> }).query = Object.fromEntries(url.searchParams);
    (vreq as { body: unknown }).body = body;

    const vres = res as unknown as VercelResponse;
    vres.status = (code: number) => {
      res.statusCode = code;
      return vres;
    };
    vres.json = (obj: unknown) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(obj));
      return vres;
    };
    Promise.resolve(handler(vreq, vres)).catch((err) => {
      console.error(err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: "internal" }));
      }
    });
  });
});

const port = Number(process.env.DEV_API_PORT ?? 3210);
server.listen(port, () => console.log(`dev api on :${port}`));
