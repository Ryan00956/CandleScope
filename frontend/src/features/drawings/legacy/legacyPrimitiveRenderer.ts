import { exportDrawingDocument } from "../core/drawingCodec.js";
import type { DrawingDocument } from "../core/drawingDocument.js";
import { createPrimitiveFromSavedDrawing } from "../drawingPrimitiveFactory.js";
import type { DrawingPrimitive, SavedDrawing } from "../drawingTypes.js";

export type LegacyPrimitiveFactory = (drawing: SavedDrawing) => DrawingPrimitive | null;

export interface LegacyPrimitiveSurface {
  attachPrimitive?(primitive: DrawingPrimitive): boolean | void;
  detachPrimitive?(primitive: DrawingPrimitive): boolean | void;
}

export interface LegacyPrimitiveRendererOptions {
  surface?: LegacyPrimitiveSurface;
  createPrimitive?: LegacyPrimitiveFactory;
}

export interface LegacyPrimitiveRenderer {
  /** Atomically materialize and replace the current canonical snapshot. */
  reconcile(document: DrawingDocument): boolean;
  /** Alias used by lifecycle code that treats each document as a full snapshot. */
  replaceDocument(document: DrawingDocument): boolean;
  /**
   * Register primitives that the legacy controller already attached itself.
   * This path performs no chart attach/detach operations.
   */
  adopt(document: DrawingDocument, primitives: readonly DrawingPrimitive[]): boolean;
  /**
   * Adopt a registry after the controller supplied checked attach/detach
   * credentials for the completed mutation.
   */
  adoptAttached(document: DrawingDocument, primitives: readonly DrawingPrimitive[]): boolean;
  /** Validate an adoption without changing renderer or chart state. */
  canAdopt(document: DrawingDocument, primitives: readonly DrawingPrimitive[]): boolean;
  /** Record checked external surface credentials before any document validation. */
  stageAttached(primitives: readonly DrawingPrimitive[]): void;
  snapshot(): readonly DrawingPrimitive[];
  getPrimitiveById(id: string): DrawingPrimitive | null;
  /** Detach the current registry from its surface while retaining it for rebind. */
  detachSurface(): boolean;
  /** Attach the retained registry to the current surface. */
  rebindSurface(): boolean;
  /** Forget credentials after the owning chart confirms that surface removal completed. */
  releaseSurfaceCredentials(): void;
  /** Rebuild fresh primitives from a canonical snapshot after a failed draft. */
  restoreDocument(document: DrawingDocument): boolean;
  detachAll(): boolean;
  dispose(): void;
}

function primitiveId(primitive: DrawingPrimitive): string | null {
  const candidate = primitive as DrawingPrimitive & { id?: unknown; _id?: unknown };
  if (typeof candidate.id === "string") return candidate.id;
  return typeof candidate._id === "string" ? candidate._id : null;
}

/**
 * Build a complete legacy primitive collection without touching the chart.
 * A single codec/factory/id failure rejects the whole candidate collection.
 */
export function materializeLegacyPrimitives(
  document: DrawingDocument,
  createPrimitive: LegacyPrimitiveFactory = createPrimitiveFromSavedDrawing,
): DrawingPrimitive[] | null {
  const saved = exportDrawingDocument(document);
  if (!saved) return null;
  const primitives: DrawingPrimitive[] = [];
  try {
    for (const drawing of saved) {
      const primitive = createPrimitive(drawing);
      if (!primitive || primitiveId(primitive) !== drawing.id) return null;
      primitives.push(primitive);
    }
    return primitives;
  } catch {
    return null;
  }
}

function invokeSurfaceAction(
  action: ((primitive: DrawingPrimitive) => boolean | void) | undefined,
  primitive: DrawingPrimitive,
): boolean {
  if (!action) return true;
  try {
    return action(primitive) !== false;
  } catch {
    return false;
  }
}

function adoptionRegistry(
  document: DrawingDocument,
  primitives: readonly DrawingPrimitive[],
): Map<string, DrawingPrimitive> | null {
  const saved = exportDrawingDocument(document);
  if (!saved || saved.length !== primitives.length) return null;
  const byId = new Map<string, DrawingPrimitive>();
  for (let index = 0; index < saved.length; index += 1) {
    const expected = saved[index];
    const primitive = primitives[index];
    if (!expected || !primitive) return null;
    const id = primitiveId(primitive);
    if (id !== expected.id || byId.has(id)) return null;
    byId.set(id, primitive);
  }
  return byId;
}

class LegacyPrimitiveRendererImpl implements LegacyPrimitiveRenderer {
  readonly #surface: LegacyPrimitiveSurface;
  readonly #createPrimitive: LegacyPrimitiveFactory;
  #primitives: DrawingPrimitive[] = [];
  #byId = new Map<string, DrawingPrimitive>();
  #document: DrawingDocument | null = null;
  #attached = new Set<DrawingPrimitive>();
  #surfaceSynchronized = true;

  constructor(options: LegacyPrimitiveRendererOptions) {
    this.#surface = options.surface ?? {};
    this.#createPrimitive = options.createPrimitive ?? createPrimitiveFromSavedDrawing;
  }

  #surfaceMatchesRegistry(): boolean {
    return this.#attached.size === this.#primitives.length
      && this.#primitives.every((primitive) => this.#attached.has(primitive));
  }

  #attach(primitive: DrawingPrimitive): boolean {
    if (this.#attached.has(primitive)) return true;
    if (!invokeSurfaceAction(this.#surface.attachPrimitive, primitive)) return false;
    this.#attached.add(primitive);
    return true;
  }

  #detach(primitive: DrawingPrimitive): boolean {
    if (!this.#attached.has(primitive)) return true;
    if (!invokeSurfaceAction(this.#surface.detachPrimitive, primitive)) return false;
    this.#attached.delete(primitive);
    return true;
  }

  #setRegistry(
    document: DrawingDocument | null,
    primitives: readonly DrawingPrimitive[],
    byId?: Map<string, DrawingPrimitive>,
  ): void {
    this.#document = document;
    this.#primitives = [...primitives];
    this.#byId = byId ?? new Map(primitives.flatMap((primitive) => {
      const id = primitiveId(primitive);
      return id ? [[id, primitive] as const] : [];
    }));
    this.#surfaceSynchronized = this.#surfaceMatchesRegistry();
  }

  reconcile(document: DrawingDocument): boolean {
    if (document === this.#document) {
      return this.#surfaceSynchronized ? true : this.rebindSurface();
    }

    // Recover every retained credential before replacing the logical registry.
    // A failed compensation is retryable and never forgotten or duplicated.
    if (!this.#surfaceSynchronized && !this.rebindSurface()) return false;

    // Phase one is pure construction. Never detach the current collection until
    // every candidate has passed the codec and primitive factory boundaries.
    const candidates = materializeLegacyPrimitives(document, this.#createPrimitive);
    if (!candidates) return false;

    const attachedCandidates: DrawingPrimitive[] = [];
    for (const primitive of candidates) {
      if (!this.#attach(primitive)) {
        for (let index = attachedCandidates.length - 1; index >= 0; index -= 1) {
          const attached = attachedCandidates[index];
          if (attached) this.#detach(attached);
        }
        this.#surfaceSynchronized = this.#surfaceMatchesRegistry();
        return false;
      }
      attachedCandidates.push(primitive);
    }

    // Phase two replaces the attached snapshot. If detaching an old primitive
    // fails, restore already-detached old entries and remove the candidate set.
    const detachedPrevious: DrawingPrimitive[] = [];
    for (const primitive of this.#primitives) {
      if (!this.#detach(primitive)) {
        for (const detached of detachedPrevious) {
          this.#attach(detached);
        }
        for (let index = attachedCandidates.length - 1; index >= 0; index -= 1) {
          const attached = attachedCandidates[index];
          if (attached) this.#detach(attached);
        }
        this.#surfaceSynchronized = this.#surfaceMatchesRegistry();
        return false;
      }
      detachedPrevious.push(primitive);
    }

    const byId = new Map<string, DrawingPrimitive>();
    for (const primitive of candidates) {
      const id = primitiveId(primitive);
      if (id) byId.set(id, primitive);
    }
    this.#setRegistry(document, candidates, byId);
    return this.#surfaceSynchronized;
  }

  replaceDocument(document: DrawingDocument): boolean {
    return this.reconcile(document);
  }

  adopt(document: DrawingDocument, primitives: readonly DrawingPrimitive[]): boolean {
    const byId = adoptionRegistry(document, primitives);
    if (!byId) return false;
    this.#setRegistry(document, primitives, byId);
    return true;
  }

  adoptAttached(document: DrawingDocument, primitives: readonly DrawingPrimitive[]): boolean {
    const byId = adoptionRegistry(document, primitives);
    if (!byId) return false;
    this.stageAttached(primitives);
    this.#setRegistry(document, primitives, byId);
    return this.#surfaceSynchronized;
  }

  canAdopt(document: DrawingDocument, primitives: readonly DrawingPrimitive[]): boolean {
    return adoptionRegistry(document, primitives) !== null;
  }

  stageAttached(primitives: readonly DrawingPrimitive[]): void {
    const previous = new Set(this.#primitives);
    const next = new Set(primitives);
    for (const primitive of this.#primitives) {
      if (!next.has(primitive)) this.#attached.delete(primitive);
    }
    // The controller only supplies new surface credentials for objects that
    // entered its registry during this mutation. Existing objects retain their
    // last checked credential: a partially detached registry must never be
    // silently certified as attached by a later style/move command.
    for (const primitive of primitives) {
      if (!previous.has(primitive)) this.#attached.add(primitive);
    }
    this.#surfaceSynchronized = this.#surfaceMatchesRegistry();
  }

  snapshot(): readonly DrawingPrimitive[] {
    return Object.freeze([...this.#primitives]);
  }

  getPrimitiveById(id: string): DrawingPrimitive | null {
    return this.#byId.get(id) ?? null;
  }

  detachSurface(): boolean {
    for (const primitive of [...this.#attached]) {
      this.#detach(primitive);
    }
    this.#surfaceSynchronized = false;
    return this.#attached.size === 0;
  }

  rebindSurface(): boolean {
    const desired = new Set(this.#primitives);
    let recovered = true;
    for (const primitive of [...this.#attached]) {
      if (!desired.has(primitive) && !this.#detach(primitive)) recovered = false;
    }
    if (!recovered) {
      this.#surfaceSynchronized = false;
      return false;
    }

    const attached: DrawingPrimitive[] = [];
    for (const primitive of this.#primitives) {
      if (this.#attached.has(primitive)) continue;
      if (!this.#attach(primitive)) {
        for (let index = attached.length - 1; index >= 0; index -= 1) {
          const candidate = attached[index];
          if (candidate) this.#detach(candidate);
        }
        this.#surfaceSynchronized = false;
        return false;
      }
      attached.push(primitive);
    }
    this.#surfaceSynchronized = this.#surfaceMatchesRegistry();
    return this.#surfaceSynchronized;
  }

  releaseSurfaceCredentials(): void {
    this.#attached.clear();
    this.#surfaceSynchronized = this.#primitives.length === 0;
  }

  restoreDocument(document: DrawingDocument): boolean {
    const candidates = materializeLegacyPrimitives(document, this.#createPrimitive);
    if (!candidates) return false;
    const byId = adoptionRegistry(document, candidates);
    if (!byId) return false;
    this.#setRegistry(document, candidates, byId);
    this.#surfaceSynchronized = false;
    return this.rebindSurface();
  }

  detachAll(): boolean {
    if (!this.detachSurface()) return false;
    this.#setRegistry(null, []);
    return true;
  }

  dispose(): void {
    this.detachAll();
  }
}

export function createLegacyPrimitiveRenderer(
  options: LegacyPrimitiveRendererOptions = {},
): LegacyPrimitiveRenderer {
  return new LegacyPrimitiveRendererImpl(options);
}
