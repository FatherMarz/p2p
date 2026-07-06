import { create } from "zustand";

export type TransferStatus =
  | "awaiting-accept" // outbound: meta sent, waiting on the peer
  | "incoming" // inbound: meta received, consent prompt showing
  | "transferring"
  | "done"
  | "failed"
  | "cancelled"
  | "declined";

/** Statuses where the transfer is still live (occupies the single slot). */
const ACTIVE_STATUSES: TransferStatus[] = ["awaiting-accept", "incoming", "transferring"];

export interface Transfer {
  id: string; // transferId (uuid), minted by the sender
  direction: "send" | "receive";
  fileName: string;
  size: number;
  mime: string;
  bytesTransferred: number;
  status: TransferStatus;
  startedAt: number;
  /** Sender-only handle to the File for the byte pump. Received chunks are
   *  buffered in the engine (not here) so progress updates don't drag
   *  hundreds of MB through Zustand state. */
  file?: File;
  error?: string;
}

/** The session-level connection lifecycle, separate from any one transfer. */
export type SessionStatus =
  | "idle" // landing page, nothing started
  | "waiting" // sender: room created, passphrase shown, no peer yet
  | "connecting" // handshake in flight
  | "connected" // data channel open
  | "closed"; // terminal: peer left / code dead / connection failed

interface TransferState {
  transfer: Transfer | null;
  session: SessionStatus;
  /** Why the session closed, for the error screen. */
  sessionError: string | null;
  setTransfer: (t: Transfer | null) => void;
  updateTransfer: (updates: Partial<Transfer>) => void;
  setProgress: (id: string, bytes: number) => void;
  setSession: (s: SessionStatus, error?: string | null) => void;
  /** Fail the transfer if it is non-terminal (peer left, channel closed). */
  failActive: (error: string) => void;
  reset: () => void;
}

export function isActiveTransfer(t: Transfer): boolean {
  return ACTIVE_STATUSES.includes(t.status);
}

export const useTransferStore = create<TransferState>((set) => ({
  transfer: null,
  session: "idle",
  sessionError: null,

  setTransfer: (t) => set({ transfer: t }),
  updateTransfer: (updates) =>
    set((s) => (s.transfer ? { transfer: { ...s.transfer, ...updates } } : s)),
  setProgress: (id, bytes) =>
    set((s) =>
      s.transfer && s.transfer.id === id
        ? { transfer: { ...s.transfer, bytesTransferred: bytes } }
        : s,
    ),
  setSession: (session, error = null) => set({ session, sessionError: error }),
  failActive: (error) =>
    set((s) =>
      s.transfer && isActiveTransfer(s.transfer)
        ? { transfer: { ...s.transfer, status: "failed", error, file: undefined } }
        : s,
    ),
  reset: () => set({ transfer: null, session: "idle", sessionError: null }),
}));

// Sugar for use outside React components (the WebRTC engine).
export const transfers = {
  get: (id: string) => {
    const t = useTransferStore.getState().transfer;
    return t && t.id === id ? t : undefined;
  },
  current: () => useTransferStore.getState().transfer,
  set: (t: Transfer | null) => useTransferStore.getState().setTransfer(t),
  update: (id: string, u: Partial<Transfer>) => {
    const t = useTransferStore.getState().transfer;
    if (t && t.id === id) useTransferStore.getState().updateTransfer(u);
  },
  setProgress: (id: string, bytes: number) => useTransferStore.getState().setProgress(id, bytes),
  hasActive: () => {
    const t = useTransferStore.getState().transfer;
    return !!t && isActiveTransfer(t);
  },
  failActive: (error: string) => useTransferStore.getState().failActive(error),
};

export const session = {
  set: (s: SessionStatus, error?: string | null) =>
    useTransferStore.getState().setSession(s, error ?? null),
  get: () => useTransferStore.getState().session,
};
