import React from "react";
import { X } from "lucide-react";
import { CATEGORY_ORDER, GLOSSARY_TERMS } from "./glossaryTerms";

interface Props {
  open: boolean;
  onClose: () => void;
}

// A single shared glossary, rendered once at the app shell so every view gets
// the same definitions. Uses the native <dialog> element for focus trapping,
// Esc-to-close, and a backdrop without extra JS.
export default function GlossaryDialog({ open, onClose }: Props) {
  const ref = React.useRef<HTMLDialogElement>(null);

  // Drive the dialog's modal state from the `open` prop.
  React.useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  // Esc and backdrop dismissal both fire the dialog's native close event;
  // funnel them through onClose so the parent owns the open state.
  const handleClose = React.useCallback(() => onClose(), [onClose]);

  // Clicking the backdrop registers as a click on the <dialog> itself (its
  // children sit in the inner panel), so close when the target is the dialog.
  const handleClick = (event: React.MouseEvent<HTMLDialogElement>) => {
    if (event.target === ref.current) onClose();
  };

  return (
    <dialog
      ref={ref}
      className="glossary-dialog"
      aria-labelledby="glossary-title"
      onClose={handleClose}
      onClick={handleClick}
    >
      <div className="glossary-panel">
        <header className="glossary-header">
          <h2 id="glossary-title">Glossary</h2>
          <button
            type="button"
            className="glossary-close"
            aria-label="Close glossary"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <div className="glossary-body">
          {CATEGORY_ORDER.map((category) => {
            const terms = GLOSSARY_TERMS.filter((t) => t.category === category);
            if (terms.length === 0) return null;
            return (
              <section key={category} className="glossary-section">
                <h3 className="glossary-category">{category}</h3>
                <dl className="glossary-terms">
                  {terms.map((t) => (
                    <div key={t.term} className="glossary-entry">
                      <dt>{t.term}</dt>
                      <dd>{t.definition}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            );
          })}
        </div>
      </div>
    </dialog>
  );
}
