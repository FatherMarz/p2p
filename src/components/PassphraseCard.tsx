import { useState } from "react";

export default function PassphraseCard({ code }: { code: string }) {
  const [copied, setCopied] = useState<"code" | "link" | null>(null);

  const copy = (what: "code" | "link") => {
    const text = what === "code" ? code : `${location.origin}/#${code}`;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  return (
    <div className="tile p-6 text-center">
      <span className="live-dot absolute right-3 top-3" data-testid="waiting-dot" />
      <div className="stamp mb-4">One-Time Passphrase</div>
      <div className="display select-all break-words text-2xl text-accent sm:text-3xl" data-testid="passphrase">
        {code}
      </div>
      <p className="mt-4 text-sm text-text-muted">
        Tell it to the other person. They open this site, hit Receive, and type it in.
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-3">
        <button className="btn" onClick={() => copy("code")}>
          {copied === "code" ? "Copied" : "Copy passphrase"}
        </button>
        <button className="btn" onClick={() => copy("link")}>
          {copied === "link" ? "Copied" : "Copy link"}
        </button>
      </div>
      <p className="mt-5 text-xs text-text-muted">
        Good for one use. Dies if you close this tab.
      </p>
    </div>
  );
}
