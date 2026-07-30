import assert from "node:assert/strict";
import test from "node:test";
import { parseScriptRuntimeCatalog } from "../indicatorContracts.js";
import {
  resolveAvailableScriptLanguage,
  resolveScriptEditorProfile,
  runtimeForScriptLanguage,
} from "../scriptRuntimeCatalog.js";

const payload = {
  schemaVersion: 1,
  defaultLanguage: "pyne",
  languages: [
    {
      id: "pyne",
      name: "Pyne",
      extensions: [".pyne"],
      aliases: ["pyne"],
      runtimeId: "candlescope.pyne",
      routeMode: "sidecar",
      available: true,
      features: ["batch-execution/1"],
    },
    {
      id: "pine",
      name: "Pine Script",
      extensions: [".pine"],
      aliases: ["pine", "pinescript"],
      runtimeId: "candlescope.pine-compat",
      routeMode: "sidecar",
      available: true,
      features: ["batch-execution/1"],
    },
    {
      id: "community-lang",
      name: "Community Lang",
      extensions: [".community"],
      aliases: ["community"],
      runtimeId: "community.runtime",
      routeMode: "sidecar",
      available: true,
      features: ["batch-execution/1"],
    },
  ],
  runtimes: [
    {
      id: "candlescope.pyne",
      name: "Pyne Runtime",
      version: "0.2.0",
      package: "candlescope-plugin-pyne",
      languages: [
        { id: "pyne", name: "Pyne", extensions: [".pyne"], aliases: ["pyne"] },
      ],
      features: ["batch-execution/1"],
      requiredHostFeatures: ["batch-execution/1"],
      meta: {},
    },
    {
      id: "candlescope.pine-compat",
      name: "Pine Compatibility Runtime",
      version: "0.2.0",
      package: "candlescope-plugin-pine-compat",
      languages: [
        {
          id: "pine",
          name: "Pine Script",
          extensions: [".pine"],
          aliases: ["pine", "pinescript"],
        },
      ],
      features: ["batch-execution/1"],
      requiredHostFeatures: ["batch-execution/1"],
      meta: {
        closedBarsOnly: true,
        hostCapabilities: {
          chartContext: {
            symbolFeatures: ["syminfo.tickerid"],
            timeframeFeatures: ["timeframe.period"],
          },
        },
        ui: {
          languages: {
            pine: {
              monacoLanguage: "pine",
              starterSource: "//@version=6\nindicator(\"My Indicator\")",
            },
          },
        },
      },
    },
    {
      id: "community.runtime",
      name: "Community Runtime",
      version: "1.0.0",
      package: "community-runtime",
      languages: [
        {
          id: "community-lang",
          name: "Community Lang",
          extensions: [".community"],
          aliases: ["community"],
        },
      ],
      features: ["batch-execution/1"],
      requiredHostFeatures: ["batch-execution/1"],
      meta: {
        ui: {
          languages: {
            "community-lang": {
              monacoLanguage: "javascript",
              starterSource: "plot(close)",
            },
          },
        },
      },
    },
  ],
};

test("runtime catalog accepts arbitrary descriptor-declared language ids", () => {
  const catalog = parseScriptRuntimeCatalog(payload);
  const language = resolveAvailableScriptLanguage(catalog, "community-lang");
  const runtime = language ? runtimeForScriptLanguage(catalog, language) : null;

  assert.equal(language?.id, "community-lang");
  assert.equal(runtime?.package, "community-runtime");
  assert.deepEqual(resolveScriptEditorProfile(catalog, language!), {
    monacoLanguage: "javascript",
    theme: "vs-dark",
    starterSource: "plot(close)",
    pyneEnhancements: false,
    pineEnhancements: false,
  });
});

test("runtime catalog enables the safe Pine editor from its descriptor", () => {
  const catalog = parseScriptRuntimeCatalog(payload);
  const language = resolveAvailableScriptLanguage(catalog, "pine");

  assert.deepEqual(resolveScriptEditorProfile(catalog, language!), {
    monacoLanguage: "pine",
    theme: "vs-dark",
    starterSource: "//@version=6\nindicator(\"My Indicator\")",
    pyneEnhancements: false,
    pineEnhancements: true,
  });
});

test("runtime catalog defaults only when no language was requested", () => {
  const catalog = parseScriptRuntimeCatalog(payload);
  const language = resolveAvailableScriptLanguage(catalog, "");

  assert.equal(language?.id, "pyne");
  assert.equal(resolveScriptEditorProfile(catalog, language!).monacoLanguage, "python");
});

test("runtime catalog fails closed for a missing saved language", () => {
  const catalog = parseScriptRuntimeCatalog(payload);

  assert.equal(
    resolveAvailableScriptLanguage(catalog, "missing-language"),
    null,
  );
});

test("runtime catalog fails closed for an unavailable saved language", () => {
  const unavailablePayload = structuredClone(payload);
  unavailablePayload.languages[1]!.available = false;
  const catalog = parseScriptRuntimeCatalog(unavailablePayload);

  assert.equal(resolveAvailableScriptLanguage(catalog, "pine"), null);
});

test("runtime catalog rejects a routed language with an unknown runtime", () => {
  const invalid = structuredClone(payload);
  invalid.languages[1]!.runtimeId = "missing.runtime";

  assert.throws(
    () => parseScriptRuntimeCatalog(invalid),
    /unknown runtime id missing\.runtime/,
  );
});
