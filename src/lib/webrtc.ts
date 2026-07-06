import { transfers, session } from "@/stores/transferStore";

// Engine ported from Basecamp's P2P file transfer
// (basecamp/client/src/lib/webrtc.ts). Same wire protocol and constants;
// simplified from a voice-mesh side channel to a dedicated 1:1 connection.
// The sender is always the offerer, so there is no signaling glare.

const DEFAULT_ICE: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

/** Preferred chunk size, clamped at send time to the negotiated SCTP
 *  maxMessageSize (~256KB on Chromium, larger on Firefox). Falls back to
 *  64KB if the transport doesn't report a limit. */
const FILE_CHUNK_SIZE = 256 * 1024;
const FILE_CHUNK_FALLBACK = 64 * 1024;
const FILE_BUFFER_HIGH_WATER = 4 * 1024 * 1024;
const FILE_BUFFER_LOW_THRESHOLD = 1 * 1024 * 1024;

/** Sanity ceiling for a transfer offer. Bytes go peer-to-peer and the receiver
 *  streams them straight to disk (File System Access API), so this guards
 *  against absurd offer sizes — it is NOT a memory constraint. */
export const MAX_TRANSFER_BYTES = 16 * 1024 * 1024 * 1024;
/** Cap for the in-memory fallback path used by browsers without streaming-to-
 *  disk (Firefox, Safari, all mobile). There the receiver assembles the whole
 *  file as a Blob in the tab, so it must stay small enough not to OOM. */
export const MEMORY_FALLBACK_CAP = 250 * 1024 * 1024;

/** How long the sender waits on the consent prompt before giving up. */
const ACCEPT_TIMEOUT_MS = 60_000;

type SaveFilePicker = (opts?: { suggestedName?: string }) => Promise<FileSystemFileHandle>;
export function getSaveFilePicker(): SaveFilePicker | null {
  if (typeof window === "undefined") return null;
  if ((window as unknown as { __p2pForceMemoryPath?: boolean }).__p2pForceMemoryPath) return null;
  const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  return typeof picker === "function" ? picker.bind(window) : null;
}
export function supportsStreamingDownload(): boolean {
  return getSaveFilePicker() !== null;
}

/** Throttle store progress writes — each one is a React commit. Scale the
 *  step to ~1% of the file, with a floor for small files. */
const PROGRESS_GRANULARITY = 256 * 1024;
function progressStep(totalBytes: number): number {
  return Math.max(PROGRESS_GRANULARITY, Math.ceil(totalBytes / 100));
}

// Control messages are JSON strings; payload is raw ArrayBuffer chunks.
// meta/accept/decline replace Basecamp's Socket.IO consent handshake — here
// they ride the same data channel, before any bytes flow. One active transfer
// at a time, so bare binary chunks unambiguously belong to the inbound one.
type ControlMessage =
  | { t: "meta"; transferId: string; name: string; size: number; mime: string }
  | { t: "accept"; transferId: string }
  | { t: "decline"; transferId: string; reason?: string }
  | { t: "begin"; transferId: string; name: string; size: number; mime: string }
  | { t: "end"; transferId: string }
  | { t: "cancel"; transferId: string };

interface InboundFileState {
  transferId: string;
  chunks: ArrayBuffer[];
  writable: FileSystemWritableFileStream | null;
  writeChain: Promise<void>;
  bytesReceived: number;
  expectedSize: number;
  lastProgressAt: number;
  progressStep: number;
}

export type Role = "send" | "receive";

export interface SignalMessage {
  rev: number;
  kind: "offer" | "answer" | "candidate";
  payload: RTCSessionDescriptionInit | RTCIceCandidateInit | null;
}

export interface EngineCallbacks {
  /** Ship a signal to the peer via the mailbox. */
  sendSignal: (msg: SignalMessage) => void;
  /** The connection failed and (sender-side) a relay-escalated ICE restart is
   *  going out — the signaling layer should resume polling for the answer. */
  onNeedsSignaling: () => void;
  /** Terminal: the connection is gone for good. */
  onClosed: (reason: string) => void;
}

const MAX_ICE_RESTARTS = 2;

export class P2PEngine {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private readonly role: Role;
  private readonly cb: EngineCallbacks;
  private iceConfig: RTCConfiguration = DEFAULT_ICE;

  /** Signaling generation. Bumped by the sender on each ICE restart; stale
   *  candidates from an earlier generation are dropped. */
  private rev = 0;
  private relayEscalated = false;
  private iceRestarts = 0;
  private disconnectGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private acceptTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  private inbound: InboundFileState | null = null;
  private pendingInboundSink: { transferId: string; writable: FileSystemWritableFileStream } | null =
    null;
  private cancelledTransfers = new Set<string>();
  private outboundFile: { transferId: string; file: File } | null = null;

  constructor(role: Role, callbacks: EngineCallbacks) {
    this.role = role;
    this.cb = callbacks;
  }

  async start(): Promise<void> {
    try {
      const res = await fetch("/api/ice");
      if (res.ok) this.iceConfig = (await res.json()) as RTCConfiguration;
    } catch {
      // STUN-only fallback keeps same-network transfers working.
    }
    this.createPeer();
    if (this.role === "send") await this.negotiate(false);
  }

  private createPeer() {
    const config: RTCConfiguration = this.relayEscalated
      ? { ...this.iceConfig, iceTransportPolicy: "relay" }
      : this.iceConfig;
    const pc = new RTCPeerConnection(config);

    pc.onicecandidate = (e) => {
      // Null candidate = end of gathering for this generation; the mailbox
      // consumer only cares about real ones.
      if (e.candidate) {
        this.cb.sendSignal({ rev: this.rev, kind: "candidate", payload: e.candidate.toJSON() });
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === "connected") {
        this.clearDisconnectGrace();
        session.set("connected");
        return;
      }
      if (state === "disconnected") {
        // Could be a transient blip — wait 5s before treating as failure.
        if (this.disconnectGraceTimer) return;
        this.disconnectGraceTimer = setTimeout(() => {
          this.disconnectGraceTimer = null;
          if (pc.connectionState === "disconnected") this.handleFailure();
        }, 5000);
        return;
      }
      if (state === "failed") {
        this.clearDisconnectGrace();
        this.handleFailure();
        return;
      }
      if (state === "closed") {
        this.teardown("Peer disconnected");
      }
    };

    // Pre-create the file channel. negotiated:true with a fixed id means both
    // sides mint matching endpoints that pair on the initial offer/answer —
    // no ondatachannel event, no extra renegotiation.
    const dc = pc.createDataChannel("files", { negotiated: true, id: 0, ordered: true });
    dc.binaryType = "arraybuffer";
    dc.bufferedAmountLowThreshold = FILE_BUFFER_LOW_THRESHOLD;
    this.wireDataChannel(dc);

    this.pc = pc;
    this.dc = dc;
  }

  private async negotiate(iceRestart: boolean) {
    if (!this.pc) return;
    const offer = await this.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
    await this.pc.setLocalDescription(offer);
    this.cb.sendSignal({ rev: this.rev, kind: "offer", payload: offer });
  }

  /** Feed a signal fetched from the mailbox. */
  async handleSignal(msg: SignalMessage): Promise<void> {
    const pc = this.pc;
    if (!pc || this.closed) return;
    try {
      if (msg.kind === "offer" && this.role === "receive") {
        if (msg.rev < this.rev) return; // stale generation
        if (msg.rev > this.rev) {
          // Sender escalated to relay and restarted ICE — mirror the policy so
          // we also re-gather relay candidates.
          this.rev = msg.rev;
          if (!this.relayEscalated) {
            this.relayEscalated = true;
            pc.setConfiguration({ ...this.iceConfig, iceTransportPolicy: "relay" });
          }
        }
        await pc.setRemoteDescription(msg.payload as RTCSessionDescriptionInit);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.cb.sendSignal({ rev: this.rev, kind: "answer", payload: answer });
      } else if (msg.kind === "answer" && this.role === "send") {
        if (msg.rev !== this.rev) return;
        if (pc.signalingState !== "have-local-offer") return;
        await pc.setRemoteDescription(msg.payload as RTCSessionDescriptionInit);
      } else if (msg.kind === "candidate") {
        if (msg.rev !== this.rev) return;
        await pc.addIceCandidate(msg.payload as RTCIceCandidateInit).catch(() => {});
      }
    } catch {
      // A malformed or out-of-order signal must not kill the session; ICE will
      // either converge with what it has or hit the failure path below.
    }
  }

  /** First failure: the direct path is unusable for this pair. Flip to
   *  TURN-only before restarting so ICE re-gathers relay candidates instead of
   *  re-selecting the same broken srflx pair (the Basecamp cross-network fix).
   *  Only the sender initiates the restart offer — no glare. */
  private handleFailure() {
    if (this.closed || !this.pc) return;
    if (this.iceRestarts >= MAX_ICE_RESTARTS) {
      this.teardown("Connection failed");
      return;
    }
    this.iceRestarts += 1;
    if (!this.relayEscalated) {
      this.relayEscalated = true;
      this.pc.setConfiguration({ ...this.iceConfig, iceTransportPolicy: "relay" });
    }
    session.set("connecting");
    this.cb.onNeedsSignaling();
    if (this.role === "send") {
      this.rev += 1;
      void this.negotiate(true).catch(() => this.teardown("Connection failed"));
    }
  }

  // --- File transfer (ported verbatim from Basecamp where possible) ---------

  private wireDataChannel(dc: RTCDataChannel) {
    dc.onclose = () => {
      if (this.dc !== dc) return;
      // The pc-level failure path owns recovery; a channel close outside that
      // (peer tab gone) fails the active transfer.
      this.dropActiveTransfer("Connection closed");
    };
    dc.onmessage = (event) => {
      if (typeof event.data === "string") {
        let msg: ControlMessage;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        void this.handleControl(msg);
      } else if (event.data instanceof ArrayBuffer) {
        this.handleChunk(event.data);
      }
    };
  }

  /** Sender: offer a file to the connected peer. Sends meta and waits for
   *  their accept/decline (over the data channel). */
  async offerFile(file: File): Promise<void> {
    if (transfers.hasActive()) throw new Error("A transfer is already in progress");
    if (file.size <= 0) throw new Error("That file is empty");
    if (file.size > MAX_TRANSFER_BYTES) throw new Error("File is too large to send");
    const dc = await this.openChannel();
    const transferId = crypto.randomUUID();
    this.outboundFile = { transferId, file };
    transfers.set({
      id: transferId,
      direction: "send",
      fileName: file.name,
      size: file.size,
      mime: file.type,
      bytesTransferred: 0,
      status: "awaiting-accept",
      startedAt: Date.now(),
      file,
    });
    dc.send(
      JSON.stringify({
        t: "meta",
        transferId,
        name: file.name,
        size: file.size,
        mime: file.type,
      } satisfies ControlMessage),
    );
    this.acceptTimer = setTimeout(() => {
      const t = transfers.get(transferId);
      if (t && t.status === "awaiting-accept") {
        this.sendControl({ t: "cancel", transferId });
        transfers.update(transferId, { status: "failed", error: "No response", file: undefined });
        this.outboundFile = null;
      }
    }, ACCEPT_TIMEOUT_MS);
  }

  /** Receiver: accept the incoming offer. MUST be called inside the click
   *  gesture — the save picker needs user activation. */
  async acceptIncoming(): Promise<void> {
    const t = transfers.current();
    if (!t || t.direction !== "receive" || t.status !== "incoming") return;

    const picker = getSaveFilePicker();
    if (picker) {
      let writable: FileSystemWritableFileStream;
      try {
        const handle = await picker({ suggestedName: t.fileName });
        writable = await handle.createWritable();
      } catch (err) {
        // AbortError = they dismissed the save dialog; leave the prompt up.
        if (err instanceof DOMException && err.name === "AbortError") return;
        transfers.update(t.id, { status: "failed", error: "Could not open a file to save into" });
        this.sendControl({ t: "decline", transferId: t.id });
        return;
      }
      const stale = this.pendingInboundSink;
      if (stale) void stale.writable.abort().catch(() => {});
      this.pendingInboundSink = { transferId: t.id, writable };
    } else if (t.size > MEMORY_FALLBACK_CAP) {
      // No disk streaming in this browser and the file won't fit in memory.
      transfers.update(t.id, {
        status: "failed",
        error: "Too large for this browser. Use desktop Chrome, Edge or Brave",
      });
      this.sendControl({ t: "decline", transferId: t.id, reason: "too-big" });
      return;
    }

    transfers.update(t.id, { status: "transferring" });
    this.sendControl({ t: "accept", transferId: t.id });
  }

  declineIncoming(): void {
    const t = transfers.current();
    if (!t || t.direction !== "receive" || t.status !== "incoming") return;
    transfers.update(t.id, { status: "declined" });
    this.sendControl({ t: "decline", transferId: t.id });
  }

  /** Cancel from either side: tell the peer, stop the pump, free buffers. */
  cancelTransfer(transferId: string): void {
    this.cancelledTransfers.add(transferId);
    if (this.inbound?.transferId === transferId) {
      const inbound = this.inbound;
      this.inbound = null;
      if (inbound.writable) {
        const w = inbound.writable;
        void inbound.writeChain.catch(() => {}).then(() => w.abort().catch(() => {}));
      }
    }
    if (this.pendingInboundSink?.transferId === transferId) {
      const pending = this.pendingInboundSink;
      this.pendingInboundSink = null;
      void pending.writable.abort().catch(() => {});
    }
    if (this.outboundFile?.transferId === transferId) this.outboundFile = null;
    this.sendControl({ t: "cancel", transferId });
    const t = transfers.get(transferId);
    if (t && (t.status === "transferring" || t.status === "awaiting-accept" || t.status === "incoming")) {
      transfers.update(transferId, { status: "cancelled", file: undefined });
    }
  }

  private sendControl(msg: ControlMessage) {
    if (this.dc?.readyState === "open") {
      try {
        this.dc.send(JSON.stringify(msg));
      } catch {
        // Channel died mid-send — teardown paths handle the rest.
      }
    }
  }

  private async handleControl(msg: ControlMessage) {
    if (!msg || typeof msg.transferId !== "string") return;

    if (msg.t === "meta") {
      // New inbound offer. Only honored when idle — one transfer at a time.
      if (transfers.hasActive()) {
        this.sendControl({ t: "decline", transferId: msg.transferId, reason: "busy" });
        return;
      }
      if (typeof msg.size !== "number" || msg.size <= 0 || msg.size > MAX_TRANSFER_BYTES) {
        this.sendControl({ t: "decline", transferId: msg.transferId, reason: "invalid" });
        return;
      }
      const cap = supportsStreamingDownload() ? MAX_TRANSFER_BYTES : MEMORY_FALLBACK_CAP;
      if (msg.size > cap) {
        this.sendControl({ t: "decline", transferId: msg.transferId, reason: "too-big" });
        transfers.set({
          id: msg.transferId,
          direction: "receive",
          fileName: msg.name,
          size: msg.size,
          mime: msg.mime,
          bytesTransferred: 0,
          status: "failed",
          error: "Too large for this browser — the sender was told",
          startedAt: Date.now(),
        });
        return;
      }
      transfers.set({
        id: msg.transferId,
        direction: "receive",
        fileName: typeof msg.name === "string" ? msg.name.slice(0, 255) : "file",
        size: msg.size,
        mime: typeof msg.mime === "string" ? msg.mime : "",
        bytesTransferred: 0,
        status: "incoming",
        startedAt: Date.now(),
      });
      return;
    }

    if (msg.t === "accept") {
      const t = transfers.get(msg.transferId);
      if (!t || t.direction !== "send" || t.status !== "awaiting-accept") return;
      this.clearAcceptTimer();
      const out = this.outboundFile;
      if (!out || out.transferId !== msg.transferId) return;
      transfers.update(msg.transferId, { status: "transferring" });
      void this.sendFile(msg.transferId, out.file);
      return;
    }

    if (msg.t === "decline") {
      const t = transfers.get(msg.transferId);
      if (!t || t.direction !== "send" || t.status !== "awaiting-accept") return;
      this.clearAcceptTimer();
      this.outboundFile = null;
      transfers.update(msg.transferId, {
        status: msg.reason === "too-big" ? "failed" : "declined",
        error: msg.reason === "too-big" ? "Too large for their browser (250MB cap without desktop Chrome)" : undefined,
        file: undefined,
      });
      return;
    }

    if (msg.t === "begin") {
      // Only honor a begin for a transfer we explicitly accepted (the consent
      // handshake set it to 'transferring'). Anything else is stale or spoofed.
      const transfer = transfers.get(msg.transferId);
      if (!transfer || transfer.direction !== "receive") return;
      if (transfer.status !== "transferring") return;
      if (this.inbound) return; // one at a time
      const pending = this.pendingInboundSink;
      const writable = pending && pending.transferId === msg.transferId ? pending.writable : null;
      this.pendingInboundSink = null;
      this.inbound = {
        transferId: msg.transferId,
        chunks: [],
        writable,
        writeChain: Promise.resolve(),
        bytesReceived: 0,
        expectedSize: transfer.size,
        lastProgressAt: 0,
        progressStep: progressStep(transfer.size),
      };
      return;
    }

    if (msg.t === "end") {
      const inbound = this.inbound;
      if (!inbound || inbound.transferId !== msg.transferId) return;
      this.inbound = null;
      const transfer = transfers.get(msg.transferId);
      if (!transfer) {
        if (inbound.writable) await inbound.writable.abort().catch(() => {});
        return;
      }
      if (inbound.bytesReceived !== transfer.size) {
        if (inbound.writable) {
          await inbound.writeChain.catch(() => {});
          await inbound.writable.abort().catch(() => {});
        }
        transfers.update(msg.transferId, { status: "failed", error: "Transfer ended early" });
        return;
      }
      if (inbound.writable) {
        // Streamed straight to the chosen file — flush queued writes and
        // commit. No synthetic <a download>; the bytes are already on disk.
        try {
          await inbound.writeChain;
          await inbound.writable.close();
        } catch {
          await inbound.writable.abort().catch(() => {});
          transfers.update(msg.transferId, { status: "failed", error: "Could not save file to disk" });
          return;
        }
      } else {
        const blob = new Blob(inbound.chunks, { type: transfer.mime || "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = transfer.fileName;
        a.click();
        // Give the browser a beat to start the download before revoking.
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }
      transfers.update(msg.transferId, { status: "done", bytesTransferred: transfer.size });
      return;
    }

    if (msg.t === "cancel") {
      const transfer = transfers.get(msg.transferId);
      if (!transfer) return;
      this.cancelledTransfers.add(msg.transferId);
      this.clearAcceptTimer();
      if (this.outboundFile?.transferId === msg.transferId) this.outboundFile = null;
      const inbound = this.inbound;
      if (inbound?.transferId === msg.transferId) {
        this.inbound = null;
        if (inbound.writable) {
          await inbound.writeChain.catch(() => {});
          await inbound.writable.abort().catch(() => {});
        }
      }
      const pending = this.pendingInboundSink;
      if (pending?.transferId === msg.transferId) {
        this.pendingInboundSink = null;
        await pending.writable.abort().catch(() => {});
      }
      if (
        transfer.status === "transferring" ||
        transfer.status === "awaiting-accept" ||
        transfer.status === "incoming"
      ) {
        transfers.update(msg.transferId, { status: "cancelled", file: undefined });
      }
    }
  }

  private handleChunk(chunk: ArrayBuffer) {
    const inbound = this.inbound;
    if (!inbound) return; // no accepted transfer — drop
    if (inbound.bytesReceived + chunk.byteLength > inbound.expectedSize) {
      // Peer is sending more than it offered — kill the transfer.
      this.inbound = null;
      if (inbound.writable) {
        const w = inbound.writable;
        void inbound.writeChain.catch(() => {}).then(() => w.abort().catch(() => {}));
      }
      transfers.update(inbound.transferId, { status: "failed", error: "Peer exceeded declared size" });
      return;
    }
    inbound.bytesReceived += chunk.byteLength;
    if (inbound.writable) {
      // Stream to disk; chain writes to preserve order. The closure holds this
      // chunk only until its write resolves, so memory stays flat.
      const w = inbound.writable;
      inbound.writeChain = inbound.writeChain.then(() => w.write(chunk));
    } else {
      inbound.chunks.push(chunk);
    }
    if (inbound.bytesReceived - inbound.lastProgressAt >= inbound.progressStep) {
      inbound.lastProgressAt = inbound.bytesReceived;
      transfers.setProgress(inbound.transferId, inbound.bytesReceived);
    }
  }

  private async openChannel(timeoutMs = 10_000): Promise<RTCDataChannel> {
    const dc = this.dc;
    if (!dc) throw new Error("Not connected");
    if (dc.readyState === "open") return dc;
    if (dc.readyState !== "connecting") throw new Error("Connection is closed");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Connection timed out")), timeoutMs);
      dc.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      dc.addEventListener("close", () => { clearTimeout(timer); reject(new Error("Connection closed")); }, { once: true });
    });
    return dc;
  }

  /** Outbound byte pump. Runs after the peer accepted. */
  private async sendFile(transferId: string, file: File): Promise<void> {
    try {
      const dc = await this.openChannel();
      // Respect the negotiated SCTP message-size ceiling.
      const maxMessage = this.pc?.sctp?.maxMessageSize ?? 0;
      const chunkSize =
        maxMessage > 0 && Number.isFinite(maxMessage)
          ? Math.min(FILE_CHUNK_SIZE, maxMessage)
          : FILE_CHUNK_FALLBACK;
      dc.send(
        JSON.stringify({
          t: "begin",
          transferId,
          name: file.name,
          size: file.size,
          mime: file.type,
        } satisfies ControlMessage),
      );

      let offset = 0;
      let lastProgressAt = 0;
      const step = progressStep(file.size);
      // Read-ahead: the next slice loads from disk while the current one sits
      // in the SCTP buffer, so file I/O and network transfer overlap.
      let pending: Promise<ArrayBuffer> = file.slice(0, chunkSize).arrayBuffer();
      while (offset < file.size) {
        if (this.cancelledTransfers.has(transferId)) {
          this.cancelledTransfers.delete(transferId);
          return;
        }
        if (dc.readyState !== "open") throw new Error("Connection lost mid-transfer");
        const chunk = await pending;
        const next = offset + chunk.byteLength;
        if (next < file.size) pending = file.slice(next, next + chunkSize).arrayBuffer();
        // Backpressure: never queue more than the high-water mark into the
        // SCTP buffer, or a fast reader-slow network combo balloons memory.
        while (dc.bufferedAmount > FILE_BUFFER_HIGH_WATER) {
          await this.awaitBufferedAmountLow(dc);
          if (this.cancelledTransfers.has(transferId)) {
            this.cancelledTransfers.delete(transferId);
            return;
          }
        }
        dc.send(chunk);
        offset = next;
        if (offset - lastProgressAt >= step || offset === file.size) {
          lastProgressAt = offset;
          transfers.setProgress(transferId, offset);
        }
      }

      dc.send(JSON.stringify({ t: "end", transferId } satisfies ControlMessage));
      transfers.update(transferId, { status: "done", bytesTransferred: file.size, file: undefined });
      this.outboundFile = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Transfer failed";
      const transfer = transfers.get(transferId);
      // A cancel that landed mid-pump already set a terminal status — keep it.
      if (transfer && transfer.status === "transferring") {
        transfers.update(transferId, { status: "failed", error: message, file: undefined });
      }
      this.outboundFile = null;
    }
  }

  private awaitBufferedAmountLow(dc: RTCDataChannel, timeoutMs = 30_000): Promise<void> {
    return new Promise((resolve, reject) => {
      // Watchdog: if the channel dies without firing 'close' cleanly, don't
      // hang the pump forever.
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Transfer stalled"));
      }, timeoutMs);
      const onLow = () => { cleanup(); resolve(); };
      const onClose = () => { cleanup(); reject(new Error("Connection closed")); };
      const cleanup = () => {
        clearTimeout(timer);
        dc.removeEventListener("bufferedamountlow", onLow);
        dc.removeEventListener("close", onClose);
      };
      dc.addEventListener("bufferedamountlow", onLow);
      dc.addEventListener("close", onClose);
    });
  }

  private dropActiveTransfer(reason: string) {
    const inbound = this.inbound;
    if (inbound?.writable) {
      const w = inbound.writable;
      void inbound.writeChain.catch(() => {}).then(() => w.abort().catch(() => {}));
    }
    this.inbound = null;
    const pending = this.pendingInboundSink;
    if (pending) {
      this.pendingInboundSink = null;
      void pending.writable.abort().catch(() => {});
    }
    this.outboundFile = null;
    this.clearAcceptTimer();
    transfers.failActive(reason);
  }

  private clearDisconnectGrace() {
    if (this.disconnectGraceTimer) {
      clearTimeout(this.disconnectGraceTimer);
      this.disconnectGraceTimer = null;
    }
  }

  private clearAcceptTimer() {
    if (this.acceptTimer) {
      clearTimeout(this.acceptTimer);
      this.acceptTimer = null;
    }
  }

  teardown(reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.clearDisconnectGrace();
    this.clearAcceptTimer();
    this.dropActiveTransfer(reason);
    try {
      this.dc?.close();
    } catch { /* already closed */ }
    try {
      this.pc?.close();
    } catch { /* already closed */ }
    this.dc = null;
    this.pc = null;
    this.cb.onClosed(reason);
  }
}
