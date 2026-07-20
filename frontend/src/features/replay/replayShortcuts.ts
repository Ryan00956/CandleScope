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
  const interactive = [
    "button", "a", "input", "textarea", "select", "option", "summary",
    "[contenteditable='true']", "[role='button']", "[role='link']", "[role='textbox']",
    ".monaco-editor", "[data-drawing-text-edit='true']",
  ].join(", ");
  return target.matches(interactive) || target.closest(interactive) !== null;
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
  onAction: (action: ReplayShortcutAction) => boolean,
): boolean {
  const action = replayShortcutAction(event);
  if (action === null) return false;
  if (!onAction(action)) return false;
  event.preventDefault();
  return true;
}
