import { useEffect, useRef } from "react";

export default function ToolFlyout({
  variants,
  currentId,
  onSelect,
  onClose,
  anchorRef,
  className = "",
}) {
  const menuRef = useRef(null);

  useEffect(() => {
    const handler = (event) => {
      if (
        menuRef.current
        && !menuRef.current.contains(event.target)
        && anchorRef.current
        && !anchorRef.current.contains(event.target)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [anchorRef, onClose]);

  return (
    <div className={`tool-flyout ${className}`.trim()} ref={menuRef}>
      {variants.map((variant) => (
        <button
          key={variant.id}
          className={`tool-flyout-item ${currentId === variant.id ? "selected" : ""}`}
          onClick={() => {
            onSelect(variant.id);
            onClose();
          }}
        >
          <span className="tool-flyout-icon">{variant.icon}</span>
          <span className="tool-flyout-label">
            <span className="tool-flyout-label-main">{variant.label}</span>
            {variant.description && (
              <span className="tool-flyout-description">{variant.description}</span>
            )}
          </span>
          {currentId === variant.id && <span className="tool-flyout-check">&#10003;</span>}
        </button>
      ))}
    </div>
  );
}
