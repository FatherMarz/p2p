const ITEMS: { q: string; a: string }[] = [
  {
    q: "How does it work?",
    a: "You pick a file and get a three-word passphrase. The other person opens this site, types it in, and accepts. The file then streams directly from your browser to theirs over a peer-to-peer connection (WebRTC). Our server only relays the few small notes the two browsers need to find each other; the file itself never touches it.",
  },
  {
    q: "Is there a file size limit?",
    a: "It depends on the receiver's browser. Desktop Chrome, Edge and Brave save the file straight to disk as it arrives, so there is no practical limit (offers are capped at 16GB for sanity). Firefox, Safari and mobile browsers have to hold the whole file in memory before saving, so they are capped at 250MB. An offer that is too big for the receiver declines itself and tells the sender why.",
  },
  {
    q: "Is it encrypted?",
    a: "Yes. WebRTC data channels are always end-to-end encrypted (DTLS), with keys negotiated directly between the two browsers. Nothing is uploaded, nothing is stored, and the bytes are unreadable to anyone in between, including us.",
  },
  {
    q: "How long does a passphrase last?",
    a: "One use, then it's gone. It also dies within seconds if the sender closes their tab, and expires on its own after a few minutes if nobody claims it. Need another? Pick the file again and you get a fresh one.",
  },
  {
    q: "Do we both need to keep the page open?",
    a: "Yes. The transfer is a live link between the two open tabs. If either side closes mid-transfer, it stops and there is no resume; grab a fresh passphrase and start again.",
  },
];

export default function Faq() {
  return (
    <section className="rise-3 mt-4">
      <div className="stamp mb-3">FAQ</div>
      <div className="flex flex-col gap-2">
        {ITEMS.map((item) => (
          <details key={item.q} className="faq tile">
            <summary className="flex cursor-pointer items-center justify-between gap-4 px-5 py-4 text-sm font-semibold">
              {item.q}
              <span className="faq-mark shrink-0 text-accent" aria-hidden>
                +
              </span>
            </summary>
            <p className="faq-answer px-5 pb-5 text-sm leading-relaxed text-text-muted">{item.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
