import { createOlcxError } from "../errors.js";
import { DEFAULT_OVERLEAF_BASE_URL, type OverleafBaseUrl } from "./types.js";

export interface ParsedProjectReference {
  projectId: string;
  projectUrl?: string;
  overleaf: {
    baseUrl: OverleafBaseUrl;
  };
}

const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;

export function parseProjectReference(value: string): ParsedProjectReference {
  const input = value.trim();

  if (input.length === 0) {
    throw invalidProjectReference("Overleaf project reference is required.");
  }

  if (looksLikeUrl(input)) {
    return parseProjectUrl(input);
  }

  if (!PROJECT_ID_PATTERN.test(input)) {
    throw invalidProjectReference("Overleaf project id is invalid.");
  }

  return { projectId: input, overleaf: { baseUrl: DEFAULT_OVERLEAF_BASE_URL } };
}

function parseProjectUrl(input: string): ParsedProjectReference {
  let url: URL;

  try {
    url = new URL(input);
  } catch {
    throw invalidProjectReference("Overleaf project URL is invalid.");
  }

  const host = url.hostname.toLowerCase();
  const baseUrl = baseUrlForProjectHost(host);
  const segments = url.pathname.split("/").filter(Boolean);
  const projectId = segments[1] ?? "";

  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    baseUrl === undefined ||
    segments.length !== 2 ||
    segments[0] !== "project" ||
    !PROJECT_ID_PATTERN.test(projectId)
  ) {
    throw invalidProjectReference(
      "Overleaf project URL must look like https://www.overleaf.com/project/<id> or https://cn.overleaf.com/project/<id>."
    );
  }

  return {
    projectId,
    projectUrl: `${baseUrl}/project/${projectId}`,
    overleaf: { baseUrl },
  };
}

function baseUrlForProjectHost(host: string): OverleafBaseUrl | undefined {
  if (host === "cn.overleaf.com") return "https://cn.overleaf.com";
  if (host === "www.overleaf.com" || host === "overleaf.com") return "https://www.overleaf.com";
  return undefined;
}

function looksLikeUrl(input: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(input);
}

function invalidProjectReference(message: string): Error {
  return createOlcxError({
    code: "USER_INPUT_ERROR",
    message,
    hint: "Pass --project with an Overleaf project id, https://www.overleaf.com/project/<id>, or https://cn.overleaf.com/project/<id> URL.",
  });
}
