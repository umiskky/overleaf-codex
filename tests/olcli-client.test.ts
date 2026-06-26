import { describe, expect, it } from "vitest";
import { OverleafClient } from "../src/backend/olcli";

describe("vendored Overleaf client", () => {
  it("downloads Overleaf docs by joining the project socket before falling back to zip", async () => {
    const client = new OverleafClient({
      cookies: { overleaf_session2: "<redacted-session-cookie>" },
      csrf: "<redacted-csrf-token>",
      baseUrl: "https://example.invalid",
    });
    const calls: string[] = [];

    (client as unknown as { getEntities: typeof client.getEntities }).getEntities = async () => {
      calls.push("getEntities");
      return [{ path: "/main.tex", type: "doc" }];
    };
    (client as unknown as { findEntityByPath: typeof client.findEntityByPath }).findEntityByPath = async () => {
      calls.push("findEntityByPath");
      return { id: "doc-id", type: "doc", name: "main.tex" };
    };
    (client as unknown as { downloadFile: typeof client.downloadFile }).downloadFile = async () => {
      calls.push("downloadFile");
      throw new Error("legacy doc endpoint should not be used");
    };
    (client as unknown as { downloadProject: typeof client.downloadProject }).downloadProject = async () => {
      calls.push("downloadProject");
      throw new Error("zip fallback should not be used");
    };
    (client as unknown as { openProjectSocket: (projectId: string) => Promise<unknown> }).openProjectSocket =
      async () => {
        calls.push("openProjectSocket");
        return {};
      };
    (client as unknown as { joinDocument: (session: unknown, docId: string) => Promise<{ content: string }> }).joinDocument =
      async () => {
        calls.push("joinDocument");
        return { content: "socket tex" };
      };
    (client as unknown as { closeProjectSocket: (session: unknown) => Promise<void> }).closeProjectSocket =
      async () => {
        calls.push("closeProjectSocket");
      };

    await expect(client.downloadByPath("<overleaf-project-id>", "main.tex")).resolves.toEqual(
      Buffer.from("socket tex", "utf8")
    );
    expect(calls).toEqual([
      "getEntities",
      "findEntityByPath",
      "openProjectSocket",
      "joinDocument",
      "closeProjectSocket",
    ]);
  });
});
