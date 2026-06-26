import { describe, expect, it } from "vitest";
import {
  assertNoRealE2eSensitiveOutput,
  loadRealE2eConfig,
  runRealOverleafE2e,
} from "../../scripts/run-real-overleaf-e2e";

const repoRoot = process.cwd();
const config = await loadRealE2eConfig({ repoRoot, processEnv: process.env });

describe("real Overleaf E2E", () => {
  if (!config.ready) {
    it.skip(config.skipMessage, () => {});
    return;
  }

  it(
    "runs the gated real Overleaf workflow without leaking configured values",
    async () => {
      const result = await runRealOverleafE2e({ repoRoot, config });

      for (const block of result.outputBlocks) {
        expect(() => assertNoRealE2eSensitiveOutput(block, config)).not.toThrow();
      }
    },
    600_000
  );
});
