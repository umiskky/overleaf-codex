import { EXIT_CODES, createOlcxError, type ExitCode } from "../cli-behavior.js";
import { findProjectRoot } from "../config/projectRoot.js";
import { readProjectConfig, writeProjectConfig } from "../config/projectConfig.js";
import {
  endpointAliasFromBaseUrl,
  formatEndpointProbeResult,
  resolveEndpointInput,
  selectFastestAvailableEndpoint,
  testOverleafEndpoints,
  type FetchLike,
} from "../endpoint/overleafEndpoint.js";

export interface EndpointCommandRuntime {
  fetchImpl?: FetchLike;
  nowMs?: () => number;
}

export async function getEndpointStatusOutput(input: { cwd: string }): Promise<string> {
  const projectRoot = await findProjectRoot(input.cwd);
  const config = await readProjectConfig(projectRoot);
  const alias = endpointAliasFromBaseUrl(config.overleaf.baseUrl);

  return [
    "olcx endpoint status",
    `Current: ${alias} (${config.overleaf.baseUrl})`,
    "Probe: not run",
  ].join("\n") + "\n";
}

export async function setEndpoint(input: { cwd: string; endpoint: string }): Promise<string> {
  const endpoint = resolveEndpointInput(input.endpoint);
  const projectRoot = await findProjectRoot(input.cwd);
  const config = await readProjectConfig(projectRoot);

  await writeProjectConfig(projectRoot, {
    ...config,
    overleaf: { baseUrl: endpoint.baseUrl },
  });

  return [
    "olcx endpoint set",
    `Set: ${endpoint.alias} (${endpoint.baseUrl})`,
  ].join("\n") + "\n";
}

export async function testEndpoint(input: {
  cwd: string;
  apply?: boolean;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  nowMs?: () => number;
}): Promise<{ output: string; exitCode: ExitCode }> {
  const timeoutMs = input.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw createOlcxError({
      code: "USER_INPUT_ERROR",
      message: "Endpoint probe timeout must be a positive integer in milliseconds.",
      hint: "Use --timeout with a value greater than 0.",
      details: { timeoutMs },
    });
  }

  const projectRoot = await findProjectRoot(input.cwd);
  const config = await readProjectConfig(projectRoot);
  const currentAlias = endpointAliasFromBaseUrl(config.overleaf.baseUrl);
  const results = await testOverleafEndpoints({
    timeoutMs,
    fetchImpl: input.fetchImpl,
    now: input.nowMs,
  });
  const fastest = selectFastestAvailableEndpoint(results);
  const lines = [
    "olcx endpoint test",
    `Current: ${currentAlias} (${config.overleaf.baseUrl})`,
    "Results:",
    ...results.map(formatEndpointProbeResult),
  ];

  if (fastest === undefined) {
    lines.push(
      "Applied: no",
      "Error: No Overleaf endpoint is reachable.",
      "Next: Check network access, proxy, firewall, or retry without --apply."
    );
    return { output: `${lines.join("\n")}\n`, exitCode: EXIT_CODES.NETWORK_ERROR };
  }

  if (input.apply === true) {
    await writeProjectConfig(projectRoot, {
      ...config,
      overleaf: { baseUrl: fastest.baseUrl },
    });
    lines.push(`Applied: ${fastest.alias}`);
  } else {
    lines.push("Applied: no", `Next: olcx endpoint set ${fastest.alias}`);
  }

  return { output: `${lines.join("\n")}\n`, exitCode: EXIT_CODES.SUCCESS };
}
