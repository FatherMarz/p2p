import { useState } from "react";
import Card from "@/components/Card";
import { getEngine, endSession } from "@/lib/connection";
import { formatBytes } from "@/lib/format";
import { supportsStreamingDownload, MEMORY_FALLBACK_CAP } from "@/lib/webrtc";
import type { Transfer } from "@/stores/transferStore";

export default function AcceptPrompt({ transfer }: { transfer: Transfer }) {
  const [busy, setBusy] = useState(false);

  const accept = async () => {
    setBusy(true);
    try {
      // Must run inside this click — the save picker needs user activation.
      await getEngine()?.acceptIncoming();
    } finally {
      setBusy(false);
    }
  };

  const decline = () => {
    getEngine()?.declineIncoming();
    endSession();
  };

  return (
    <div className="view">
      <Card stamp="Incoming File" right={<span className="live-dot" />} testId="accept-prompt">
        <div className="break-words text-lg font-semibold" data-testid="incoming-name">
          {transfer.fileName}
        </div>
        <div className="mt-1 text-sm text-text-muted">{formatBytes(transfer.size)}</div>
        {!supportsStreamingDownload() && transfer.size > MEMORY_FALLBACK_CAP * 0.8 && (
          <p className="mt-3 text-xs text-text-muted">
            Heads up: this browser holds the file in memory while receiving. Desktop
            Chrome, Edge or Brave stream straight to disk instead.
          </p>
        )}
        <div className="mt-5 flex gap-3">
          <button
            className="btn btn-primary"
            onClick={() => void accept()}
            disabled={busy}
            data-testid="accept-btn"
          >
            Accept &amp; save
          </button>
          <button className="btn" onClick={decline} disabled={busy}>
            Decline
          </button>
        </div>
      </Card>
    </div>
  );
}
