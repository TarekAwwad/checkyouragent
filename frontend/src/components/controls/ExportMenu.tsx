import React from "react";
import { Download } from "lucide-react";

export interface ExportItem {
  label: string;
  icon?: React.ReactNode;
  onSelect: () => void;
}

export default function ExportMenu({ items, disabled }: { items: ExportItem[]; disabled?: boolean }) {
  const [open, setOpen] = React.useState(false);
  const root = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="export-menu" ref={root}>
      <button type="button" className="ghost-action" aria-haspopup="menu" aria-expanded={open}
              disabled={disabled} onClick={() => setOpen((current) => !current)}>
        <Download size={14} aria-hidden="true" />
        <span>Export</span>
      </button>
      {open && (
        <div className="export-menu-list" role="menu" aria-label="Export">
          {items.map((item) => (
            <button key={item.label} type="button" role="menuitem"
                    onClick={() => { setOpen(false); item.onSelect(); }}>
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
