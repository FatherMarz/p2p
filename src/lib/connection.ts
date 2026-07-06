import { P2PEngine, type Role } from "@/lib/webrtc";
import { Mailbox, type MailboxEvent } from "@/lib/signaling";
import { session, useTransferStore } from "@/stores/transferStore";

// Session orchestrator: wires one Mailbox to one P2PEngine and owns their
// lifecycle. One session per page load; "start over" is a state reset with a
// fresh engine + fresh passphrase.

let engine: P2PEngine | null = null;
let mailbox: Mailbox | null = null;

function wire(role: Role, code: string): P2PEngine {
  const mb = new Mailbox(code, role, (e: MailboxEvent) => {
    if (e.type === "signal") void eng.handleSignal(e.msg);
    else if (e.type === "claimed") session.set("connecting");
    else if (e.type === "dead") {
      eng.teardown(e.reason === "sender-left" ? "The sender left" : "This code is no longer valid");
    }
  });
  const eng = new P2PEngine(role, {
    sendSignal: (msg) => mb.post(msg),
    onNeedsSignaling: () => mb.startPolling(),
    onClosed: (reason) => {
      mb.close();
      const s = useTransferStore.getState();
      // Don't clobber a happy ending: a completed transfer followed by the
      // peer closing their tab is normal, not an error.
      if (s.session !== "closed") {
        session.set("closed", s.transfer?.status === "done" ? null : reason);
      }
    },
  });
  engine = eng;
  mailbox = mb;
  return eng;
}

/** Sender: create a room, get the passphrase, start signaling. */
export async function startSend(): Promise<string> {
  const code = await Mailbox.createRoom();
  const eng = wire("send", code);
  session.set("waiting");
  await eng.start(); // posts the offer + candidates as they gather
  mailbox!.startPolling();
  return code;
}

/** Receiver: burn the passphrase and connect. Throws "dead" | "claimed". */
export async function startReceive(code: string): Promise<void> {
  await Mailbox.claim(code);
  const eng = wire("receive", code);
  session.set("connecting");
  await eng.start();
  mailbox!.startPolling();
}

export function getEngine(): P2PEngine | null {
  return engine;
}

// Once the P2P link is up, stop burning 1s polls — drop to the slow keepalive
// that keeps the room row warm so an ICE restart can still signal through it.
useTransferStore.subscribe((s, prev) => {
  if (s.session === "connected" && prev.session !== "connected") mailbox?.keepalive();
});

export function endSession(): void {
  engine?.teardown("Session ended");
  engine = null;
  mailbox = null;
}

// The room must die with the tab — that's the disposable-passphrase promise.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    mailbox?.close();
  });
}

// Test hook for Playwright (mirrors the Basecamp/Clamber drive-hook pattern).
declare global {
  interface Window {
    __p2p?: {
      getEngine: typeof getEngine;
      startSend: typeof startSend;
      startReceive: typeof startReceive;
      store: typeof useTransferStore;
    };
    __p2pForceMemoryPath?: boolean;
  }
}
if (typeof window !== "undefined") {
  window.__p2p = { getEngine, startSend, startReceive, store: useTransferStore };
}
