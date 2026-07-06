import { getEngine } from "@/lib/connection";
import { formatBytes } from "@/lib/format";
import type { Transfer } from "@/stores/transferStore";

const STATUS_LABEL: Record<Transfer["status"], string> = {
  "awaiting-accept": "Waiting for them to accept…",
  incoming: "Incoming…",
  transferring: "Transferring",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  declined: "Declined",
};

export default function TransferPanel({ transfer }: { transfer: Transfer }) {
  const pct = transfer.size > 0 ? Math.min(100, (transfer.bytesTransferred / transfer.size) * 100) : 0;
  const active = transfer.status === "transferring" || transfer.status === "awaiting-accept";

  return (
    <div className="tile p-6" data-testid="transfer-panel" data-status={transfer.status}>
      <div className="flex items-baseline justify-between gap-4">
        <div className="stamp">
          {transfer.direction === "send" ? "Sending" : "Receiving"}
        </div>
        <div className="text-xs text-text-muted">{STATUS_LABEL[transfer.status]}</div>
      </div>
      <div className="mt-3 break-words text-sm font-semibold">{transfer.fileName}</div>

      {transfer.status === "transferring" && (
        <>
          <div className="mt-4 h-2 border border-border bg-bg">
            <div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-2 flex justify-between text-xs text-text-muted">
            <span>
              {formatBytes(transfer.bytesTransferred)} / {formatBytes(transfer.size)}
            </span>
            <span>{pct.toFixed(0)}%</span>
          </div>
        </>
      )}

      {transfer.status === "done" && (
        <p className="mt-3 text-sm text-accent" data-testid="transfer-done">
          {formatBytes(transfer.size)} delivered.
        </p>
      )}
      {transfer.status === "failed" && (
        <p className="mt-3 text-sm text-text-muted">{transfer.error ?? "Something broke mid-flight."}</p>
      )}
      {(transfer.status === "cancelled" || transfer.status === "declined") && (
        <p className="mt-3 text-sm text-text-muted">
          {transfer.status === "declined" ? "They passed on it." : "Stopped."}
        </p>
      )}

      {active && (
        <button
          className="btn mt-5"
          onClick={() => getEngine()?.cancelTransfer(transfer.id)}
          data-testid="cancel-btn"
        >
          Cancel
        </button>
      )}
    </div>
  );
}
