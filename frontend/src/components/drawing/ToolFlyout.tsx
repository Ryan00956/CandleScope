import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { ToolbarVariant } from "./drawingToolbarDefinitions.js";

export interface ToolFlyoutProps<TId extends string = string> {
  variants: readonly ToolbarVariant<TId>[];
  currentId: TId;
  onSelect(id: TId): void;
  onClose(): void;
  anchorRef: RefObject<HTMLDivElement | null>;
  className?: string;
  isVariantDisabled?: ((variant: ToolbarVariant<TId>) => boolean) | null;
}

export default function ToolFlyout<TId extends string>({
  variants,
  currentId,
  onSelect,
  onClose,
  anchorRef,
  className = "",
  isVariantDisabled = null,
}: ToolFlyoutProps<TId>) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (!(event.target instanceof Node)) return;
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
      {variants.map((variant) => {
        const disabled = Boolean(isVariantDisabled?.(variant));
        return (
          <button
            type="button"
            key={variant.id}
            className={`tool-flyout-item ${currentId === variant.id ? "selected" : ""}`}
            data-tool-variant={variant.id}
            aria-disabled={disabled}
            disabled={disabled}
            onClick={() => {
              if (disabled) return;
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
        );
      })}
    </div>
  );
}
