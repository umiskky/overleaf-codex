import { defineConfig } from "vitest/config";

const explicitRealE2e = process.argv.some((arg) => arg.endsWith("tests/e2e/real-overleaf.e2e.ts"));

export default defineConfig({
  test: {
    include: explicitRealE2e ? ["tests/e2e/real-overleaf.e2e.ts"] : ["**/*.{test,spec}.?(c|m)[jt]s?(x)"],
  },
});
