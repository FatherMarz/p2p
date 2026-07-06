export default function SiteFooter() {
  return (
    <footer className="mt-16 pb-10 text-center text-xs text-text-muted">
      <p>
        End-to-end encrypted (DTLS), directly between the two browsers.
        Never uploaded, never stored.
      </p>
      <p className="mt-2">
        A Modul4r Tool ·{" "}
        <a className="link" href="https://modul4r.com">
          modul4r.com
        </a>{" "}
        ·{" "}
        <a className="link" href="https://github.com/FatherMarz/p2p">
          GitHub
        </a>
      </p>
    </footer>
  );
}
