import { useState } from "react";
import Card from "@/components/Card";

export default function PassphraseCard({ code }: { code: string }) {
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  const words = code.split("-");

  const copy = (what: "code" | "link") => {
    const text = what === "code" ? code : `${location.origin}/#${code}`;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  return (
    <Card
      stamp="One-Time Passphrase"
      right={<span className="live-dot" data-testid="waiting-dot" />}
      className="text-center"
    >
      <div
        className="sweep display select-all break-words text-2xl text-accent sm:text-3xl"
        data-testid="passphrase"
        aria-label={code}
      >
        {words.map((word, i) => (
          <span key={i}>
            <span className="word-in" style={{ animationDelay: `${0.15 + i * 0.28}s` }}>
              {word}
            </span>
            {i < words.length - 1 && (
              <span
                className="word-in text-text-muted"
                style={{ animationDelay: `${0.15 + i * 0.28 + 0.14}s` }}
              >
                -
              </span>
            )}
          </span>
        ))}
      </div>
      <p className="mt-6 text-sm text-text-muted">
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
      <p className="mt-5 text-xs text-text-muted">Good for one use. Dies if you close this tab.</p>
    </Card>
  );
}
