import { describe, expect, it } from "vitest";
import {
  selectFastestAvailableEndpoint,
  testOverleafEndpoints,
} from "../src/endpoint/overleafEndpoint";

type FakeFetchCall = { url: string; init?: RequestInit };

function createFakeFetch(
  handlers: Record<string, () => Promise<{ status: number; ok: boolean }> | Promise<never>>
) {
  const calls: FakeFetchCall[] = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const key = String(url);
    calls.push({ url: key, init });
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected fetch ${key}`);
    return handler();
  };
  return { fetchImpl, calls };
}

function sequenceNow(values: number[]) {
  return () => {
    const value = values.shift();
    if (value === undefined) throw new Error("clock exhausted");
    return value;
  };
}

describe("Overleaf endpoint service", () => {
  it("probes both endpoints without project-specific URLs", async () => {
    const fake = createFakeFetch({
      "https://www.overleaf.com/project": async () => ({ status: 200, ok: true }),
      "https://cn.overleaf.com/project": async () => ({ status: 302, ok: false }),
    });

    const results = await testOverleafEndpoints({
      fetchImpl: fake.fetchImpl,
      now: sequenceNow([0, 123, 123, 333]),
      timeoutMs: 1000,
    });

    expect(results.map((result) => result.alias)).toEqual(["www", "cn"]);
    expect(results).toEqual([
      expect.objectContaining({ alias: "www", available: true, latencyMs: 123, status: 200 }),
      expect.objectContaining({ alias: "cn", available: true, latencyMs: 210, status: 302 }),
    ]);
    expect(fake.calls.map((call) => call.url)).toEqual([
      "https://www.overleaf.com/project",
      "https://cn.overleaf.com/project",
    ]);
  });

  it("classifies timeout and network failures with redacted reasons", async () => {
    const timeout = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    const fake = createFakeFetch({
      "https://www.overleaf.com/project": async () => {
        throw timeout;
      },
      "https://cn.overleaf.com/project": async () => {
        throw new Error("network failed for cookie=secret and project 0123456789abcdef01234567");
      },
    });

    const results = await testOverleafEndpoints({
      fetchImpl: fake.fetchImpl,
      now: sequenceNow([0, 1000, 1000, 1200]),
      timeoutMs: 500,
    });

    expect(results).toEqual([
      expect.objectContaining({ alias: "www", available: false, failureReason: "timeout after 500ms" }),
      expect.objectContaining({ alias: "cn", available: false }),
    ]);
    expect(JSON.stringify(results)).not.toContain("secret");
    expect(JSON.stringify(results)).not.toContain("0123456789abcdef01234567");
  });

  it("selects the fastest available endpoint and returns undefined when all fail", () => {
    expect(
      selectFastestAvailableEndpoint([
        { alias: "www", baseUrl: "https://www.overleaf.com", available: true, latencyMs: 80, status: 200 },
        { alias: "cn", baseUrl: "https://cn.overleaf.com", available: true, latencyMs: 40, status: 200 },
      ])
    ).toMatchObject({ alias: "cn" });

    expect(
      selectFastestAvailableEndpoint([
        {
          alias: "www",
          baseUrl: "https://www.overleaf.com",
          available: false,
          latencyMs: 80,
          failureReason: "timeout",
        },
        {
          alias: "cn",
          baseUrl: "https://cn.overleaf.com",
          available: false,
          latencyMs: 40,
          failureReason: "network",
        },
      ])
    ).toBeUndefined();
  });
});
