import { useEffect, useRef, useState } from "react";

const POSITION_SIZE_PRESETS = [100, 500, 1000, 5000, 10000, 50000];

export default function PositionSettingsPanel({
  positionSize,
  onPositionSizeChange,
  onClose,
  anchorRef,
}) {
  const panelRef = useRef(null);
  const [localSize, setLocalSize] = useState(String(positionSize || 1000));

  useEffect(() => {
    const handler = (event) => {
      if (
        panelRef.current
        && !panelRef.current.contains(event.target)
        && anchorRef.current
        && !anchorRef.current.contains(event.target)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [anchorRef, onClose]);

  const handleSizeChange = (value) => {
    setLocalSize(value);
    const numberValue = parseFloat(value);
    if (!Number.isNaN(numberValue) && numberValue > 0) {
      onPositionSizeChange(numberValue);
    }
  };

  return (
    <div className="position-settings-panel" ref={panelRef}>
      <div className="fib-levels-header">
        <span>Position settings</span>
        <button className="fib-levels-close" onClick={onClose}>x</button>
      </div>
      <div className="fib-levels-divider" />
      <div className="position-size-section">
        <label className="position-size-label">Position size ($)</label>
        <input
          type="number"
          className="position-size-input"
          value={localSize}
          onChange={(event) => handleSizeChange(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
          min="0"
          step="100"
        />
        <div className="position-size-presets">
          {POSITION_SIZE_PRESETS.map((preset) => (
            <button
              key={preset}
              className={`position-size-preset ${Number(localSize) === preset ? "active" : ""}`}
              onClick={() => handleSizeChange(String(preset))}
            >
              {preset >= 1000 ? `${preset / 1000}K` : preset}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
