import { createOlcxError, redactSensitive } from "../cli-behavior.js";
import type { OverleafBaseUrl } from "../config/types.js";

export type OverleafEndpointAlias = "www" | "cn";

export interface OverleafEndpointDefinition {
  alias: OverleafEndpointAlias;
  baseUrl: OverleafBaseUrl;
  probeUrl: `${OverleafBaseUrl}/project`;
}

export interface EndpointProbeResult {
  alias: OverleafEndpointAlias;
  baseUrl: OverleafBaseUrl;
  available: boolean;
  latencyMs: number;
  status?: number;
  failureReason?: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<{ status: number; ok: boolean }>;

export const OVERLEAF_ENDPOINTS: readonly OverleafEndpointDefinition[] = [
  { alias: "www", baseUrl: "https://www.overleaf.com", probeUrl: "https://www.overleaf.com/project" },
  { alias: "cn", baseUrl: "https://cn.overleaf.com", probeUrl: "https://cn.overleaf.com/project" },
];

export function normalizeOverleafBaseUrl(value: string): OverleafBaseUrl {
  const normalized = value.trim().replace(/\/+$/, "");
  if (normalized === "https://www.overleaf.com" || normalized === "https://cn.overleaf.com") {
    return normalized;
  }

  throw createOlcxError({
    code: "USER_INPUT_ERROR",
    message: "Unsupported Overleaf endpoint.",
    hint: "Use endpoint alias www or cn.",
    details: { value },
  });
}

export function endpointAliasFromBaseUrl(baseUrl: OverleafBaseUrl): OverleafEndpointAlias {
  return baseUrl === "https://cn.overleaf.com" ? "cn" : "www";
}

export function resolveEndpointInput(value: string): OverleafEndpointDefinition {
  const normalized = value.trim().toLowerCase();
  const endpoint = OVERLEAF_ENDPOINTS.find(
    (candidate) => candidate.alias === normalized || candidate.baseUrl === normalized
  );

  if (endpoint === undefined) {
    throw createOlcxError({
      code: "USER_INPUT_ERROR",
      message: "Unsupported Overleaf endpoint.",
      hint: "Use endpoint alias www or cn.",
      details: { accepted: ["www", "cn"], value },
    });
  }

  return endpoint;
}

export async function probeOverleafEndpoint(input: {
  endpoint: OverleafEndpointDefinition;
  timeoutMs: number;
  fetchImpl?: FetchLike;
  now?: () => number;
}): Promise<EndpointProbeResult> {
  const fetchImpl = input.fetchImpl ?? ((url, init) => fetch(url, init));
  const now = input.now ?? Date.now;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  const started = now();

  try {
    const response = await fetchImpl(input.endpoint.probeUrl, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { "User-Agent": "olcx-endpoint-probe" },
    });
    const latencyMs = Math.max(0, Math.round(now() - started));

    if (response.status < 500) {
      return {
        alias: input.endpoint.alias,
        baseUrl: input.endpoint.baseUrl,
        available: true,
        latencyMs,
        status: response.status,
      };
    }

    return {
      alias: input.endpoint.alias,
      baseUrl: input.endpoint.baseUrl,
      available: false,
      latencyMs,
      status: response.status,
      failureReason: `http ${response.status}`,
    };
  } catch (error) {
    const latencyMs = Math.max(0, Math.round(now() - started));
    const failureReason =
      error instanceof Error && error.name === "AbortError"
        ? `timeout after ${input.timeoutMs}ms`
        : redactEndpointFailureReason(error instanceof Error ? error.message : String(error));

    return {
      alias: input.endpoint.alias,
      baseUrl: input.endpoint.baseUrl,
      available: false,
      latencyMs,
      failureReason,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function redactEndpointFailureReason(value: string): string {
  return redactSensitive(value).replace(/<redacted-secret>/g, "<redacted-value>").slice(0, 200);
}

export async function testOverleafEndpoints(input: {
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  now?: () => number;
} = {}): Promise<EndpointProbeResult[]> {
  const timeoutMs = input.timeoutMs ?? 5000;
  return Promise.all(
    OVERLEAF_ENDPOINTS.map((endpoint) =>
      probeOverleafEndpoint({
        endpoint,
        timeoutMs,
        fetchImpl: input.fetchImpl,
        now: input.now,
      })
    )
  );
}

export function selectFastestAvailableEndpoint(
  results: EndpointProbeResult[]
): EndpointProbeResult | undefined {
  return results
    .filter((result) => result.available)
    .sort((left, right) => left.latencyMs - right.latencyMs)[0];
}

export function formatEndpointProbeResult(result: EndpointProbeResult): string {
  const status = result.status === undefined ? "" : ` status ${result.status}`;
  const failure = result.failureReason === undefined ? "" : ` ${result.failureReason}`;
  return `- ${result.alias} ${result.baseUrl} ${result.available ? "available" : "unavailable"} ${result.latencyMs}ms${status}${failure}`;
}
