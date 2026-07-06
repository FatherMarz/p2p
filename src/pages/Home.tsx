import { useEffect, useRef, useState } from "react";
import { startSend, startReceive, getEngine, endSession } from "@/lib/connection";
import { useTransferStore, isActiveTransfer } from "@/stores/transferStore";
import Card from "@/components/Card";
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

  // Remount (and so re-animate) the content column whenever the screen
  // meaningfully changes — not on progress ticks.
  const viewKey = `${mode}-${session}-${transfer?.status ?? "none"}`;

  return (
    <div className="page" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col px-5 pt-14">
        <header className="rise mb-10 text-center">
          <div className="stamp justify-center">File Transfer</div>
          <h1 className="display mt-2 text-4xl text-accent">p2p file</h1>
          <p className="mt-3 text-sm text-text-muted">
            Send a file with a one-time passphrase. Encrypted, browser to browser.
            Nothing stored.
          </p>
        </header>

        <div className="flex flex-col gap-5" key={viewKey}>
          {/* Landing — pick a side */}
          {mode === "landing" && (
            <>
              <label className="tile tile-interactive rise-1 block cursor-pointer p-6 text-left">
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
                <div className="mb-4 flex items-center justify-between gap-4">
                  <span className="stamp">01 · Send a file</span>
                  <span className="text-accent" aria-hidden>
                    →
                  </span>
                </div>
                <div className="text-lg font-semibold">Pick a file</div>
                <p className="mt-2 text-sm text-text-muted">
                  or drop it anywhere on the page. You get a passphrase to pass along.
                </p>
              </label>
              <button
                className="tile tile-interactive rise-2 p-6 text-left"
                data-testid="receive-tile"
                onClick={() => setMode("receive")}
              >
                <div className="mb-4 flex items-center justify-between gap-4">
                  <span className="stamp">02 · Receive a file</span>
                  <span className="text-accent" aria-hidden>
                    →
                  </span>
                </div>
                <div className="text-lg font-semibold">I have a passphrase</div>
                <p className="mt-2 text-sm text-text-muted">
                  Type it in and the file comes straight to you.
                </p>
              </button>
            </>
          )}

          {/* Receive — passphrase entry */}
          {mode === "receive" && session === "idle" && (
            <form
              className="view"
              onSubmit={(e) => {
                e.preventDefault();
                submitReceive();
              }}
            >
              <Card stamp="Receive a file">
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
                  <button
                    className="btn btn-primary"
                    type="submit"
                    disabled={busy || !receiveInput.trim()}
                    data-testid="connect-btn"
                  >
                    {busy ? "Connecting…" : "Connect"}
                  </button>
                  <button className="btn" type="button" onClick={startOver}>
                    Back
                  </button>
                </div>
              </Card>
            </form>
          )}

          {/* Sender — passphrase + payload chip */}
          {mode === "send" && session === "waiting" && code && (
            <div className="rise">
              <PassphraseCard code={code} />
            </div>
          )}
          {mode === "send" && (session === "waiting" || session === "connecting") && pendingFile && (
            <div className="rise-1">
              <Card stamp="Payload">
                <div className="flex items-baseline justify-between gap-4 text-sm">
                  <span className="break-words font-semibold">{pendingFile.name}</span>
                  <span className="shrink-0 text-text-muted">{formatBytes(pendingFile.size)}</span>
                </div>
              </Card>
            </div>
          )}

          {/* Handshake in flight */}
          {session === "connecting" && (
            <div className="rise">
              <Card stamp="Link" right={<span className="live-dot" />}>
                <p className="caret text-sm text-text-muted">
                  {mode === "send" ? "Peer found, connecting" : "Connecting to the sender"}
                </p>
              </Card>
            </div>
          )}

          {/* Receiver connected, waiting on the offer to arrive */}
          {mode === "receive" && session === "connected" && !transfer && (
            <div className="rise">
              <Card stamp="Link" right={<span className="live-dot" />}>
                <p className="caret text-sm text-text-muted">Connected. Waiting for the file offer</p>
              </Card>
            </div>
          )}

          {/* Consent + progress */}
          {showAccept && transfer && <AcceptPrompt transfer={transfer} />}
          {showPanel && transfer && <TransferPanel transfer={transfer} />}

          {/* Sender: connected with no active transfer — offer another */}
          {senderIdleConnected && transfer?.status === "done" && (
            <label className="btn btn-primary rise-1 cursor-pointer self-center">
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
            <p className="rise-1 text-center text-xs text-text-muted">
              Still connected. They can send another file without a new passphrase.
            </p>
          )}

          {/* Session over */}
          {session === "closed" && (
            <div className="view">
              <Card stamp="Session" className="text-center">
                <p className="text-sm text-text-muted" data-testid="session-closed">
                  {sessionError ?? "Session ended."}
                </p>
                <button className="btn mt-4" onClick={startOver}>
                  Start over
                </button>
              </Card>
            </div>
          )}

          {error && (
            <p className="rise text-center text-sm text-accent" data-testid="error-text">
              {error}
            </p>
          )}
        </div>

        <SiteFooter />
      </main>
    </div>
  );
}
