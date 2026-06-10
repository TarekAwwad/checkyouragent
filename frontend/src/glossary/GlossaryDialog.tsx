import React from "react";
import { X } from "lucide-react";
import { CATEGORY_ORDER, GLOSSARY_TERMS, type GlossaryCategory } from "./glossaryTerms";

interface Props {
  open: boolean;
  onClose: () => void;
}

// A single shared glossary, rendered once at the app shell so every view gets
// the same definitions. Uses the native <dialog> element for focus trapping,
// Esc-to-close, and a backdrop without extra JS. Content is split across tabs
// (one per category) so each panel stays short and scannable.
export default function GlossaryDialog({ open, onClose }: Props) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const [activeTab, setActiveTab] = React.useState<GlossaryCategory>(CATEGORY_ORDER[0]);

  // Drive the dialog's modal state from the `open` prop, and reset to the first
  // tab on each open so it never reopens on a stale tab.
  React.useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setActiveTab(CATEGORY_ORDER[0]);
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Esc and backdrop dismissal both fire the dialog's native close event;
  // funnel them through onClose so the parent owns the open state.
  const handleClose = React.useCallback(() => onClose(), [onClose]);

  // Clicking the backdrop registers as a click on the <dialog> itself (its
  // children sit in the inner panel), so close when the target is the dialog.
  const handleClick = (event: React.MouseEvent<HTMLDialogElement>) => {
    if (event.target === ref.current) onClose();
  };

  const terms = GLOSSARY_TERMS.filter((t) => t.category === activeTab);

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
        <div className="glossary-tabs" role="tablist" aria-label="Glossary categories">
          {CATEGORY_ORDER.map((category) => (
            <button
              type="button"
              role="tab"
              key={category}
              id={`glossary-tab-${category}`}
              aria-controls="glossary-tabpanel"
              aria-selected={activeTab === category}
              className={activeTab === category ? "active" : ""}
              onClick={() => setActiveTab(category)}
            >
              {category}
            </button>
          ))}
        </div>
        <div
          className="glossary-body"
          id="glossary-tabpanel"
          role="tabpanel"
          aria-labelledby={`glossary-tab-${activeTab}`}
        >
          <dl className="glossary-terms">
            {terms.map((t) => (
              <div key={t.term} className="glossary-entry">
                <dt>{t.term}</dt>
                <dd>{t.definition}</dd>
                {t.detail && (
                  <div className="glossary-detail" aria-label="How it's computed">
                    {t.detail.map((line, index) => (
                      <span key={index}>{line || " "}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </dl>
        </div>
      </div>
    </dialog>
  );
}
