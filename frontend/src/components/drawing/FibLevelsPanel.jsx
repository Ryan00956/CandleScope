import { useEffect, useRef, useState } from "react";
import { DEFAULT_FIB_LEVELS } from "../primitives/FibonacciDrawingPrimitive.js";

const FIB_RANDOM_COLORS = [
  "#e91e63",
  "#9c27b0",
  "#673ab7",
  "#3f51b5",
  "#2196f3",
  "#00bcd4",
  "#4caf50",
  "#8bc34a",
  "#cddc39",
  "#ffc107",
  "#ff9800",
  "#ff5722",
  "#795548",
  "#607d8b",
];

export default function FibLevelsPanel({
  levels = DEFAULT_FIB_LEVELS,
  onLevelsChange,
  inverted,
  onInvertedChange,
  onClose,
  anchorRef,
}) {
  const panelRef = useRef(null);
  const [newLevelInput, setNewLevelInput] = useState("");

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

  const toggleLevel = (index) => {
    onLevelsChange(levels.map((level, itemIndex) => (
      itemIndex === index ? { ...level, enabled: !level.enabled } : level
    )));
  };

  const changeLevelColor = (index, color) => {
    onLevelsChange(levels.map((level, itemIndex) => (
      itemIndex === index ? { ...level, color } : level
    )));
  };

  const removeLevel = (index) => {
    onLevelsChange(levels.filter((_, itemIndex) => itemIndex !== index));
  };

  const addCustomLevel = () => {
    const value = parseFloat(newLevelInput);
    if (Number.isNaN(value)) return;
    if (levels.some((level) => Math.abs(level.level - value) < 0.0001)) return;

    const color = FIB_RANDOM_COLORS[levels.length % FIB_RANDOM_COLORS.length];
    const next = [...levels, { level: value, color, enabled: true }]
      .sort((a, b) => a.level - b.level);
    onLevelsChange(next);
    setNewLevelInput("");
  };

  const handleKeyDown = (event) => {
    if (event.key === "Enter") addCustomLevel();
    event.stopPropagation();
  };

  const isDefault = (level) => (
    DEFAULT_FIB_LEVELS.some((defaultLevel) => (
      Math.abs(defaultLevel.level - level.level) < 0.0001
    ))
  );

  return (
    <div className="fib-levels-panel" ref={panelRef}>
      <div className="fib-levels-header">
        <span>Fibonacci levels</span>
        <button className="fib-levels-close" onClick={onClose}>x</button>
      </div>

      <div className="fib-invert-row">
        <label className="fib-invert-label">
          <span>First click defines</span>
          <button
            className={`fib-invert-btn ${!inverted ? "active" : ""}`}
            onClick={() => onInvertedChange(false)}
          >
            0
          </button>
          <button
            className={`fib-invert-btn ${inverted ? "active" : ""}`}
            onClick={() => onInvertedChange(true)}
          >
            1
          </button>
        </label>
      </div>

      <div className="fib-levels-divider" />

      <div className="fib-levels-list">
        {levels.map((level, index) => (
          <div key={index} className="fib-level-row">
            <input
              type="checkbox"
              checked={level.enabled}
              onChange={() => toggleLevel(index)}
              className="fib-level-check"
            />
            <input
              type="color"
              value={level.color}
              onChange={(event) => changeLevelColor(index, event.target.value)}
              className="fib-level-color"
            />
            <span className={`fib-level-value ${!level.enabled ? "disabled" : ""}`}>
              {level.level}
            </span>
            {!isDefault(level) && (
              <button className="fib-level-remove" onClick={() => removeLevel(index)} title="Remove">
                x
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="fib-add-level-row">
        <input
          type="text"
          className="fib-add-level-input"
          placeholder="Add level, e.g. 1.414"
          value={newLevelInput}
          onChange={(event) => setNewLevelInput(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button className="fib-add-level-btn" onClick={addCustomLevel}>+</button>
      </div>
    </div>
  );
}
