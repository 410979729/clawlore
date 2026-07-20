import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { assertFinalReadinessPointer } from "../scripts/release-readiness-path.mjs";

test("readiness generation requires the final absolute config pointer before binding", () => {
  const output = resolve("/tmp/clawlore-readiness.json");
  assert.equal(assertFinalReadinessPointer({
    configuredReadinessFile: output,
    readinessOut: output,
  }), output);

  assert.throws(
    () => assertFinalReadinessPointer({ configuredReadinessFile: undefined, readinessOut: output }),
    /release_readiness_pointer_missing/,
  );
  assert.throws(
    () => assertFinalReadinessPointer({ configuredReadinessFile: "readiness.json", readinessOut: output }),
    /release_readiness_pointer_must_be_absolute/,
  );
  assert.throws(
    () => assertFinalReadinessPointer({
      configuredReadinessFile: resolve("/tmp/other-readiness.json"),
      readinessOut: output,
    }),
    /release_readiness_pointer_output_mismatch/,
  );
});
