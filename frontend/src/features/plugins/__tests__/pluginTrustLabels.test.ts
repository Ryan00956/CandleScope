import assert from "node:assert/strict";
import test from "node:test";

import { LOCAL_BUNDLE_INSTALL_LABEL } from "../pluginTrustLabels.js";

test("digest-only local bundles are not labeled as publisher-signed", () => {
  assert.equal(
    LOCAL_BUNDLE_INSTALL_LABEL,
    "Install digest-verified local .cspkg bundle",
  );
  assert.doesNotMatch(LOCAL_BUNDLE_INSTALL_LABEL.toLowerCase(), /\bsigned\b/);
});
