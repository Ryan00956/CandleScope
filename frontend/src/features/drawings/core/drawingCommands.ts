import {
  canonicalDrawingValueEquals,
  cloneDrawingEntity,
  commitDrawingDocumentDraft,
  createDrawingEntity,
} from "./drawingDocument.js";
import type {
  CanonicalDrawingGeometry,
  DrawingDocument,
  DrawingEntity,
  DrawingEntityInput,
  DrawingStyle,
} from "./drawingDocument.js";

export interface CreateDrawingCommand {
  readonly at?: number;
  readonly entity: DrawingEntityInput;
  readonly type: "create";
}

export interface UpdateDrawingStyleCommand {
  readonly id: string;
  readonly patch: Readonly<Record<string, unknown>>;
  readonly type: "update-style";
}

export interface MoveDrawingCommand {
  readonly geometry: CanonicalDrawingGeometry;
  readonly id: string;
  readonly type: "move";
}

export interface ResizeDrawingCommand {
  readonly geometry: CanonicalDrawingGeometry;
  readonly id: string;
  readonly type: "resize";
}

export interface DeleteDrawingCommand {
  readonly id: string;
  readonly type: "delete";
}

export interface ClearDrawingsCommand {
  readonly type: "clear";
}

export interface ReorderDrawingsCommand {
  readonly order: readonly string[];
  readonly type: "reorder";
}

export type DrawingCommand =
  | CreateDrawingCommand
  | UpdateDrawingStyleCommand
  | MoveDrawingCommand
  | ResizeDrawingCommand
  | DeleteDrawingCommand
  | ClearDrawingsCommand
  | ReorderDrawingsCommand;

export interface DrawingCommandApplySuccess {
  readonly changed: boolean;
  readonly document: DrawingDocument;
  readonly ok: true;
}

export interface DrawingCommandApplyFailure {
  readonly changed: false;
  readonly commandIndex: number;
  readonly document: DrawingDocument;
  readonly error: string;
  readonly ok: false;
}

export type DrawingCommandApplyResult = DrawingCommandApplySuccess | DrawingCommandApplyFailure;

interface MutableDrawingDraft {
  changed: boolean;
  entities: Map<string, DrawingEntity>;
  zOrder: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(
  document: DrawingDocument,
  commandIndex: number,
  error: unknown,
): DrawingCommandApplyFailure {
  return Object.freeze({
    changed: false,
    commandIndex,
    document,
    error: error instanceof Error ? error.message : String(error),
    ok: false,
  });
}

function applyCreate(draft: MutableDrawingDraft, command: CreateDrawingCommand): void {
  const entity = createDrawingEntity(command.entity) as DrawingEntity;
  if (draft.entities.has(entity.id)) throw new TypeError(`drawing entity already exists: ${entity.id}`);
  const at = command.at ?? draft.zOrder.length;
  if (!Number.isSafeInteger(at) || at < 0 || at > draft.zOrder.length) {
    throw new RangeError("drawing create index is outside zOrder");
  }
  draft.entities.set(entity.id, entity);
  draft.zOrder.splice(at, 0, entity.id);
  draft.changed = true;
}

function applyUpdateStyle(draft: MutableDrawingDraft, command: UpdateDrawingStyleCommand): void {
  const entity = draft.entities.get(command.id);
  if (!entity) throw new TypeError(`drawing entity does not exist: ${command.id}`);
  if (!isRecord(command.patch)) throw new TypeError("drawing style patch must be a plain record");
  if (Object.keys(command.patch).length === 0) return;
  const nextStyle: Record<string, unknown> = { ...entity.style };
  for (const [key, value] of Object.entries(command.patch)) {
    Object.defineProperty(nextStyle, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }
  if (canonicalDrawingValueEquals(entity.style, nextStyle)) return;
  draft.entities.set(entity.id, cloneDrawingEntity(entity, {
    style: nextStyle as DrawingStyle,
    styleRevision: entity.styleRevision + 1,
  }));
  draft.changed = true;
}

function applyGeometry(
  draft: MutableDrawingDraft,
  command: MoveDrawingCommand | ResizeDrawingCommand,
): void {
  const entity = draft.entities.get(command.id);
  if (!entity) throw new TypeError(`drawing entity does not exist: ${command.id}`);
  if (canonicalDrawingValueEquals(entity.geometry, command.geometry)) return;
  draft.entities.set(entity.id, cloneDrawingEntity(entity, {
    bounds: { kind: "deferred" },
    geometry: command.geometry,
    geometryRevision: entity.geometryRevision + 1,
  }));
  draft.changed = true;
}

function applyDelete(draft: MutableDrawingDraft, command: DeleteDrawingCommand): void {
  if (!draft.entities.has(command.id)) return;
  draft.entities.delete(command.id);
  const index = draft.zOrder.indexOf(command.id);
  if (index >= 0) draft.zOrder.splice(index, 1);
  draft.changed = true;
}

function applyClear(draft: MutableDrawingDraft): void {
  if (draft.entities.size === 0) return;
  draft.entities.clear();
  draft.zOrder.length = 0;
  draft.changed = true;
}

function applyReorder(draft: MutableDrawingDraft, command: ReorderDrawingsCommand): void {
  const orderValue: unknown = command.order;
  if (!Array.isArray(orderValue)
    || orderValue.length !== draft.entities.size
    || new Set(orderValue).size !== orderValue.length
    || orderValue.some((id: unknown) => typeof id !== "string" || !draft.entities.has(id))) {
    throw new TypeError("drawing reorder must be an exact entity-id permutation");
  }
  const order = orderValue as string[];
  if (order.every((id, index) => draft.zOrder[index] === id)) return;
  draft.zOrder = [...order];
  draft.changed = true;
}

function applyOne(draft: MutableDrawingDraft, command: DrawingCommand): void {
  if (!isRecord(command) || typeof command.type !== "string") {
    throw new TypeError("invalid drawing command");
  }
  switch (command.type) {
    case "create":
      applyCreate(draft, command);
      return;
    case "update-style":
      applyUpdateStyle(draft, command);
      return;
    case "move":
    case "resize":
      applyGeometry(draft, command);
      return;
    case "delete":
      applyDelete(draft, command);
      return;
    case "clear":
      applyClear(draft);
      return;
    case "reorder":
      applyReorder(draft, command);
      return;
    default:
      throw new TypeError("unknown drawing command");
  }
}

/**
 * Apply one command transaction. Every command is staged before a new
 * immutable document is published. A batch has one document revision even
 * when it updates several entity revisions.
 */
export function applyDrawingCommands(
  document: DrawingDocument,
  commands: readonly DrawingCommand[],
): DrawingCommandApplyResult {
  if (!Array.isArray(commands)) return fail(document, 0, "drawing commands must be an array");
  if (commands.length === 0) return Object.freeze({ changed: false, document, ok: true });
  const draft: MutableDrawingDraft = {
    changed: false,
    entities: new Map(document.entities),
    zOrder: [...document.zOrder],
  };
  for (let index = 0; index < commands.length; index += 1) {
    try {
      applyOne(draft, commands[index] as DrawingCommand);
    } catch (error) {
      return fail(document, index, error);
    }
  }
  if (!draft.changed) return Object.freeze({ changed: false, document, ok: true });
  try {
    const next = commitDrawingDocumentDraft(document, draft.entities, draft.zOrder);
    return Object.freeze({ changed: true, document: next, ok: true });
  } catch (error) {
    return fail(document, commands.length - 1, error);
  }
}
