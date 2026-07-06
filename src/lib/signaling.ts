import type { Role, SignalMessage } from "@/lib/webrtc";

// Polling mailbox client. WebRTC signaling is a one-shot exchange (offer,
// answer, a dozen candidates over ~5s), so short-lived 1s polling against a
// serverless endpoint replaces a standing socket. Polls stop once the P2P
// connection is up and resume only for an ICE-restart; a slow keepalive poll
// keeps the room row (and the sender-liveness heartbeat) alive meanwhile.

const HANDSHAKE_POLL_MS = 1000;
const KEEPALIVE_POLL_MS = 45_000;

export type MailboxEvent =
  | { type: "signal"; msg: SignalMessage }
  | { type: "claimed" } // sender-side: a receiver typed the passphrase
  | { type: "dead"; reason: "gone" | "sender-left" }; // room vanished / sender stopped heartbeating

export class Mailbox {
  readonly code: string;
  private readonly role: Role;
  private readonly onEvent: (e: MailboxEvent) => void;
  private cursor = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private mode: "fast" | "keepalive" | "stopped" = "stopped";
  private closed = false;
  private sawClaim = false;

  constructor(code: string, role: Role, onEvent: (e: MailboxEvent) => void) {
    this.code = code;
    this.role = role;
    this.onEvent = onEvent;
  }

  static async createRoom(): Promise<string> {
    const res = await fetch("/api/room", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "create" }),
    });
    if (!res.ok) throw new Error("Could not create a code. Try again.");
    const { code } = (await res.json()) as { code: string };
    return code;
  }

  /** Receiver: consume the one-time passphrase. Throws "dead" | "claimed". */
  static async claim(code: string): Promise<void> {
    const res = await fetch("/api/signal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "claim", code }),
    });
    if (res.ok) return;
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error === "claimed" ? "claimed" : "dead");
  }

  post(msg: SignalMessage): void {
    if (this.closed) return;
    void fetch("/api/signal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "append", code: this.code, role: this.role, msgs: [msg] }),
    }).catch(() => {
      // Transient network hiccup — the peer's poll simply won't see this
      // message; ICE converges on the candidates that did land.
    });
  }

  startPolling(): void {
    this.mode = "fast";
    this.schedule(0);
  }

  /** Handshake done — drop to the slow heartbeat that keeps the room alive. */
  keepalive(): void {
    this.mode = "keepalive";
    this.schedule(KEEPALIVE_POLL_MS);
  }

  stop(): void {
    this.mode = "stopped";
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Tear the room down (tab close / session over). Beacon-safe. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stop();
    const payload = JSON.stringify({ action: "close", code: this.code });
    if (typeof navigator !== "undefined" && navigator.sendBeacon) {
      navigator.sendBeacon("/api/room", new Blob([payload], { type: "application/json" }));
    } else {
      void fetch("/api/room", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      }).catch(() => {});
    }
  }

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.mode === "stopped" || this.closed) return;
    this.timer = setTimeout(() => void this.poll(), delay);
  }

  private async poll(): Promise<void> {
    if (this.closed || this.mode === "stopped") return;
    try {
      const res = await fetch(
        `/api/signal?code=${encodeURIComponent(this.code)}&role=${this.role}&after=${this.cursor}`,
      );
      if (res.status === 404) {
        this.stop();
        this.onEvent({ type: "dead", reason: "gone" });
        return;
      }
      if (res.ok) {
        const data = (await res.json()) as {
          msgs: SignalMessage[];
          total: number;
          claimed: boolean;
          senderAlive: boolean;
        };
        this.cursor = data.total;
        if (this.role === "send" && data.claimed && !this.sawClaim) {
          this.sawClaim = true;
          this.onEvent({ type: "claimed" });
        }
        if (this.role === "receive" && !data.senderAlive) {
          this.stop();
          this.onEvent({ type: "dead", reason: "sender-left" });
          return;
        }
        for (const msg of data.msgs) this.onEvent({ type: "signal", msg });
      }
    } catch {
      // Network blip — keep polling; the room reaper is the source of truth.
    }
    this.schedule(this.mode === "fast" ? HANDSHAKE_POLL_MS : KEEPALIVE_POLL_MS);
  }
}
