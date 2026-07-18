export type ReplayShortcutAction = "toggle-play" | "step" | "advance-window";

export interface ReplayShortcutEventLike {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly repeat: boolean;
  readonly target: EventTarget | null;
  preventDefault(): void;
}

export function isReplayShortcutFocusTarget(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  return target.matches("input, textarea, select, [contenteditable='true'], [role='textbox']")
    || target.closest("input, textarea, select, [contenteditable='true'], [role='textbox'], .monaco-editor, [data-drawing-text-edit='true']") !== null;
}

export function replayShortcutAction(event: ReplayShortcutEventLike): ReplayShortcutAction | null {
  if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || isReplayShortcutFocusTarget(event.target)) return null;
  if ((event.key === " " || event.key === "Spacebar") && !event.shiftKey) return "toggle-play";
  if (event.key === "ArrowRight" && event.shiftKey) return "advance-window";
  if (event.key === "ArrowRight" && !event.shiftKey) return "step";
  return null;
}

export function handleReplayShortcut(
  event: ReplayShortcutEventLike,
  onAction: (action: ReplayShortcutAction) => void,
): boolean {
  const action = replayShortcutAction(event);
  if (action === null) return false;
  event.preventDefault();
  onAction(action);
  return true;
}
