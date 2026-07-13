import { HeikinAshiProjector } from "./projectors/heikinAshiProjector.js";
import { IdentityProjector } from "./projectors/identityProjector.js";
import { KagiProjector } from "./projectors/kagiProjector.js";
import { LineBreakProjector } from "./projectors/lineBreakProjector.js";
import { PointFigureProjector } from "./projectors/pointFigureProjector.js";
import { RenkoProjector } from "./projectors/renkoProjector.js";
import type { Projector } from "./chartRepresentationTypes.js";

type ProjectorFactory = (options?: Record<string, unknown>) => Projector;

const PROJECTOR_FACTORIES = new Map<string, ProjectorFactory>([
  ["identity", () => new IdentityProjector()],
  ["heikin-ashi", () => new HeikinAshiProjector()],
  ["renko", (options) => new RenkoProjector(options)],
  ["point-and-figure", (options) => new PointFigureProjector(options)],
  ["kagi", (options) => new KagiProjector(options)],
  ["line-break", (options) => new LineBreakProjector(options)],
]);

export function registerProjectorFactory(
  id: unknown,
  factory: ProjectorFactory,
  { replace = false }: { replace?: boolean } = {},
): void {
  const key = String(id || "").trim();
  if (!key || typeof factory !== "function") {
    throw new TypeError("projector factory requires a non-empty id and function");
  }
  if (!replace && PROJECTOR_FACTORIES.has(key)) {
    throw new Error(`projector factory already registered: ${key}`);
  }
  PROJECTOR_FACTORIES.set(key, factory);
}

export function createProjector(
  projectionId = "identity",
  options: Record<string, unknown> = {},
): Projector {
  const factory = PROJECTOR_FACTORIES.get(projectionId);
  if (!factory) throw new Error(`unknown chart projection: ${projectionId}`);
  return factory(options);
}
