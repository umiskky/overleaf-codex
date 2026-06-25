import { describe, expect, it } from "vitest";
import { buildCli } from "../src/cli";

describe("olcx cli scaffold", () => {
  it("shows the planned command surface in help", () => {
    const help = buildCli().helpInformation();

    expect(help).toContain("olcx");
    expect(help).toContain("auth");
    expect(help).toContain("init");
    expect(help).toContain("sync");
    expect(help).toContain("compile");
    expect(help).toContain("watch");
    expect(help).toContain("status");
    expect(help).toContain("doctor");
  });
});
