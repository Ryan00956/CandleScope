/**
 * PaneResizer — draggable divider between chart panes.
 *
 * Fires onResize(deltaY) during drag so the parent can redistribute
 * height between the pane above and below.
 */
import { useCallback, useRef } from "react";

export default function PaneResizer({ onResize, onResizeEnd }) {
    const draggingRef = useRef(false);
    const startYRef = useRef(0);

    const handleMouseDown = useCallback((e) => {
        e.preventDefault();
        draggingRef.current = true;
        startYRef.current = e.clientY;

        const handleMouseMove = (e2) => {
            if (!draggingRef.current) return;
            const deltaY = e2.clientY - startYRef.current;
            startYRef.current = e2.clientY;
            onResize?.(deltaY);
        };

        const handleMouseUp = () => {
            draggingRef.current = false;
            document.removeEventListener("mousemove", handleMouseMove);
            document.removeEventListener("mouseup", handleMouseUp);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            onResizeEnd?.();
        };

        document.body.style.cursor = "row-resize";
        document.body.style.userSelect = "none";
        document.addEventListener("mousemove", handleMouseMove);
        document.addEventListener("mouseup", handleMouseUp);
    }, [onResize, onResizeEnd]);

    return (
        <div
            className="pane-resizer"
            onMouseDown={handleMouseDown}
        >
            <div className="pane-resizer-handle" />
        </div>
    );
}
