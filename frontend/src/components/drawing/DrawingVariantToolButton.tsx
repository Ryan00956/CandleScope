import ToolFlyout from "./ToolFlyout.js";
import type { ComponentPropsWithoutRef, ReactNode, RefObject } from "react";
import type { ToolbarVariant } from "./drawingToolbarDefinitions.js";

type VariantButtonEvents = Pick<
  ComponentPropsWithoutRef<"button">,
  "onClick" | "onContextMenu" | "onDoubleClick"
>;

export interface DrawingVariantToolButtonProps<TId extends string = string> extends VariantButtonEvents {
  active: boolean;
  anchorRef: RefObject<HTMLDivElement | null>;
  buttonClassName?: string;
  children?: ReactNode;
  currentId: TId;
  dataChartType?: string;
  dataDrawingTool?: string;
  disabled?: boolean;
  flyoutClassName?: string;
  flyoutKey: string;
  flyoutOpen: string | null;
  icon: ReactNode;
  isVariantDisabled?: ((variant: ToolbarVariant<TId>) => boolean) | null;
  onCloseFlyout(): void;
  onSelect(id: TId): void;
  title: string;
  variants: readonly ToolbarVariant<TId>[];
  wrapperClassName?: string;
}

const CornerTriangle = (
  <svg
    className="tool-variant-indicator"
    width="6"
    height="6"
    viewBox="0 0 6 6"
    style={{ position: "absolute", right: 2, bottom: 2 }}
  >
    <polygon points="6,0 6,6 0,6" fill="currentColor" opacity="0.55" />
  </svg>
);

export default function DrawingVariantToolButton<TId extends string>({
  active,
  anchorRef,
  buttonClassName = "",
  children,
  currentId,
  dataChartType,
  dataDrawingTool,
  disabled = false,
  flyoutClassName = "",
  flyoutKey,
  flyoutOpen,
  icon,
  isVariantDisabled,
  onClick,
  onCloseFlyout,
  onContextMenu,
  onDoubleClick,
  onSelect,
  title,
  variants,
  wrapperClassName = "",
}: DrawingVariantToolButtonProps<TId>) {
  return (
    <div className={`drawing-tool-wrapper ${wrapperClassName}`.trim()} ref={anchorRef}>
      <button
        type="button"
        className={`drawing-tool-btn ${buttonClassName} ${active ? "active" : ""}`.trim()}
        data-chart-type={dataChartType}
        data-drawing-tool={dataDrawingTool}
        disabled={disabled}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        title={title}
        aria-label={title}
      >
        {icon}
        {CornerTriangle}
      </button>
      {!disabled && flyoutOpen === flyoutKey && (
        <ToolFlyout
          variants={variants}
          currentId={currentId}
          onSelect={onSelect}
          onClose={onCloseFlyout}
          anchorRef={anchorRef}
          className={flyoutClassName}
          {...(isVariantDisabled === undefined ? {} : { isVariantDisabled })}
        />
      )}
      {!disabled && children}
    </div>
  );
}
