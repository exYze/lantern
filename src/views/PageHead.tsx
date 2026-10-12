import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "../components/ui";
import { useApp } from "../lib/store";

export function PageHead({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <IconButton label="Back" className="only-narrow" onClick={() => useApp.setState({ navOpen: true })}>
        <ChevronLeft size={20} />
      </IconButton>
      <div className="page-head-text">
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="page-head-actions">{actions}</div>}
    </header>
  );
}
