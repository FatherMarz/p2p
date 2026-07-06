import type { ReactNode } from "react";

/** The one card shape every screen uses: tile, stamp row, body. */
export default function Card({
  stamp,
  right,
  children,
  className = "",
  testId,
}: {
  stamp: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section className={`tile p-6 ${className}`} data-testid={testId}>
      <div className="mb-4 flex items-center justify-between gap-4">
        <div className="stamp">{stamp}</div>
        {right}
      </div>
      {children}
    </section>
  );
}
