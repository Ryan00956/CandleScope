import { HeikinAshiProjector } from "./projectors/heikinAshiProjector.js";
import { IdentityProjector } from "./projectors/identityProjector.js";
import { RenkoProjector } from "./projectors/renkoProjector.js";

const PROJECTOR_FACTORIES = new Map([
  ["identity", () => new IdentityProjector()],
  ["heikin-ashi", () => new HeikinAshiProjector()],
  ["renko", (options) => new RenkoProjector(options)],
]);

export function registerProjectorFactory(id, factory, { replace = false } = {}) {
  const key = String(id || "").trim();
  if (!key || typeof factory !== "function") {
    throw new TypeError("projector factory requires a non-empty id and function");
  }
  if (!replace && PROJECTOR_FACTORIES.has(key)) {
    throw new Error(`projector factory already registered: ${key}`);
  }
  PROJECTOR_FACTORIES.set(key, factory);
}

export function createProjector(projectionId = "identity", options = {}) {
  const factory = PROJECTOR_FACTORIES.get(projectionId);
  if (!factory) throw new Error(`unknown chart projection: ${projectionId}`);
  return factory(options);
}
