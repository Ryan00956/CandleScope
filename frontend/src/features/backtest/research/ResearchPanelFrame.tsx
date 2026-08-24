import type { PropsWithChildren, ReactNode } from "react";

export default function ResearchPanelFrame({
  title,
  eyebrow,
  trailing = null,
  children,
  className = "",
}: PropsWithChildren<{
  title: string;
  eyebrow: string;
  trailing?: ReactNode;
  className?: string;
}>) {
  return (
    <section className={`research-panel ${className}`.trim()}>
      <header>
        <div><small>{eyebrow}</small><strong>{title}</strong></div>
        {trailing}
      </header>
      <div className="research-panel-body">{children}</div>
    </section>
  );
}
