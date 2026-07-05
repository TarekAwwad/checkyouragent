import React from "react";
import { X } from "lucide-react";
import UsageCharacteristicsPanel from "./UsageCharacteristicsPanel";

interface Props {
  open: boolean;
  onClose: () => void;
  projectId: number | null;
}

// A /usage-style "what's driving your usage?" panel in a modal. Native <dialog>
// for focus trapping, Esc, and a backdrop (same pattern as GlossaryDialog). The
// body is shared verbatim with the Explore "Usage drivers" page.
export default function UsageCharacteristicsDialog({ open, onClose, projectId }: Props) {
  const ref = React.useRef<HTMLDialogElement>(null);

  React.useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  const handleClick = (event: React.MouseEvent<HTMLDialogElement>) => {
    if (event.target === ref.current) onClose();
  };

  return (
    <dialog
      ref={ref}
      className="glossary-dialog usage-characteristics-dialog"
      aria-labelledby="usage-characteristics-title"
      onClose={onClose}
      onClick={handleClick}
    >
      <div className="glossary-panel">
        <header className="glossary-header">
          <h2 id="usage-characteristics-title">What's driving your usage</h2>
          <button type="button" className="glossary-close"
                  aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <UsageCharacteristicsPanel projectId={projectId} enabled={open} />
      </div>
    </dialog>
  );
}
