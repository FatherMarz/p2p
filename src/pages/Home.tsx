import { useEffect, useRef, useState } from "react";
import { startSend, startReceive, getEngine, endSession } from "@/lib/connection";
import { useTransferStore, isActiveTransfer } from "@/stores/transferStore";
import PassphraseCard from "@/components/PassphraseCard";
import AcceptPrompt from "@/components/AcceptPrompt";
import TransferPanel from "@/components/TransferPanel";
import SiteFooter from "@/components/SiteFooter";
import { formatBytes } from "@/lib/format";

type Mode = "landing" | "send" | "receive";

function hashCode(): string {
  const h = window.location.hash.replace(/^#/, "").trim();
  return /^[a-z]+(-[a-z]+){1,4}$/.test(h) ? h : "";
}

export default function Home() {
  const [mode, setMode] = useState<Mode>(() => (hashCode() ? "receive" : "landing"));
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [receiveInput, setReceiveInput] = useState(() => hashCode());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const offeredRef = useRef<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const transfer = useTransferStore((s) => s.transfer);
  const session = useTransferStore((s) => s.session);
  const sessionError = useTransferStore((s) => s.sessionError);

  // Sender: the file was picked before the peer existed — offer it the moment
  // the data channel is up. The ref stops re-renders from re-offering.
  useEffect(() => {
    if (mode !== "send" || session !== "connected") return;
    if (!pendingFile || offeredRef.current === pendingFile) return;
    offeredRef.current = pendingFile;
    void getEngine()
      ?.offerFile(pendingFile)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not offer the file"));
  }, [mode, session, pendingFile]);

  // Both tabs must stay open mid-transfer (no resume) — warn on close.
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      const t = useTransferStore.getState().transfer;
      if (t && t.status === "transferring") e.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, []);

  const beginSend = (file: File) => {
    setError(null);
    setPendingFile(file);
    setMode("send");
    setBusy(true);
    startSend()
      .then(setCode)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Could not create a passphrase"),
      )
      .finally(() => setBusy(false));
  };

  const sendAnother = (file: File) => {
    setError(null);
    setPendingFile(file);
    offeredRef.current = file;
    void getEngine()
      ?.offerFile(file)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not offer the file"));
  };

  const submitReceive = () => {
    setError(null);
    setBusy(true);
    startReceive(receiveInput)
      .catch((err: unknown) => {
        const kind = err instanceof Error ? err.message : "dead";
        setError(
          kind === "claimed"
            ? "That passphrase was already used. Each one works exactly once. Ask for a fresh one."
            : "That passphrase isn't live. Check the spelling, or ask the sender for a fresh one (their tab has to stay open).",
        );
      })
      .finally(() => setBusy(false));
  };

  const startOver = () => {
    endSession();
    history.replaceState(null, "", window.location.pathname);
    window.location.reload();
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file && mode === "landing") beginSend(file);
  };

  const showAccept = transfer?.direction === "receive" && transfer.status === "incoming";
  const showPanel =
    transfer && !showAccept && (isActiveTransfer(transfer) || transfer.status !== "incoming");
  const senderIdleConnected =
    mode === "send" && session === "connected" && (!transfer || !isActiveTransfer(transfer));

  return (
    <div className="page" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col px-5 pt-14">
        <header className="mb-10 text-center">
          <h1 className="display text-4xl text-accent">p2p</h1>
          <p className="mt-2 text-sm text-text-muted">
            One-time passphrase. Encrypted, browser to browser. Nothing stored.
          </p>
        </header>

        <div className="flex flex-col gap-5">
          {/* Landing — pick a side */}
          {mode === "landing" && (
            <>
              <label className="tile tile-interactive block cursor-pointer p-8 text-center">
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  data-testid="file-input"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) beginSend(f);
                  }}
                />
                <div className="stamp mb-3">Send</div>
                <div className="text-lg font-semibold">Pick a file</div>
                <p className="mt-2 text-sm text-text-muted">or drop it anywhere on the page</p>
              </label>
              <button
                className="tile tile-interactive p-8 text-center"
                data-testid="receive-tile"
                onClick={() => setMode("receive")}
              >
                <div className="stamp mb-3">Receive</div>
                <div className="text-lg font-semibold">I have a passphrase</div>
              </button>
            </>
          )}

          {/* Receive — passphrase entry */}
          {mode === "receive" && session === "idle" && (
            <form
              className="tile p-6"
              onSubmit={(e) => {
                e.preventDefault();
                submitReceive();
              }}
            >
              <div className="stamp mb-4">Receive</div>
              <label className="block text-sm text-text-muted" htmlFor="passphrase">
                Type the passphrase you were given
              </label>
              <input
                id="passphrase"
                data-testid="passphrase-input"
                className="mt-3 w-full border border-border bg-bg px-4 py-3 font-mono text-lg text-text outline-none focus:border-accent"
                placeholder="correct-horse-battery"
                value={receiveInput}
                onChange={(e) => setReceiveInput(e.target.value)}
                autoFocus
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              <div className="mt-4 flex gap-3">
                <button className="btn btn-primary" type="submit" disabled={busy || !receiveInput.trim()} data-testid="connect-btn">
                  {busy ? "Connecting…" : "Connect"}
                </button>
                <button className="btn" type="button" onClick={startOver}>
                  Back
                </button>
              </div>
            </form>
          )}

          {/* Sender — passphrase + waiting */}
          {mode === "send" && session === "waiting" && code && <PassphraseCard code={code} />}
          {mode === "send" && (session === "waiting" || session === "connecting") && pendingFile && (
            <div className="tile flex items-baseline justify-between gap-4 px-5 py-4 text-sm">
              <span className="break-words font-semibold">{pendingFile.name}</span>
              <span className="shrink-0 text-text-muted">{formatBytes(pendingFile.size)}</span>
            </div>
          )}

          {/* Handshake in flight */}
          {session === "connecting" && (
            <div className="tile p-6 text-center">
              <span className="live-dot mr-2" />
              <span className="text-sm text-text-muted">
                {mode === "send" ? "Peer found, connecting…" : "Connecting to the sender…"}
              </span>
            </div>
          )}

          {/* Receiver connected, waiting on the offer to arrive */}
          {mode === "receive" && session === "connected" && !transfer && (
            <div className="tile p-6 text-center text-sm text-text-muted">
              Connected. Waiting for the file offer…
            </div>
          )}

          {/* Consent + progress */}
          {showAccept && transfer && <AcceptPrompt transfer={transfer} />}
          {showPanel && transfer && <TransferPanel transfer={transfer} />}

          {/* Sender: connected with no active transfer — offer another */}
          {senderIdleConnected && transfer?.status === "done" && (
            <label className="btn btn-primary cursor-pointer self-center">
              Send another file
              <input
                type="file"
                className="hidden"
                data-testid="file-input-again"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) sendAnother(f);
                }}
              />
            </label>
          )}

          {/* Receiver done — hint that the line is still open */}
          {mode === "receive" && session === "connected" && transfer?.status === "done" && (
            <p className="text-center text-xs text-text-muted">
              Still connected. They can send another file without a new passphrase.
            </p>
          )}

          {/* Session over */}
          {session === "closed" && (
            <div className="tile p-6 text-center">
              <p className="text-sm text-text-muted" data-testid="session-closed">
                {sessionError ?? "Session ended."}
              </p>
              <button className="btn mt-4" onClick={startOver}>
                Start over
              </button>
            </div>
          )}

          {error && (
            <p className="text-center text-sm text-accent" data-testid="error-text">
              {error}
            </p>
          )}
        </div>

        <SiteFooter />
      </main>
    </div>
  );
}
