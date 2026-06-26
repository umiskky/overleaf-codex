import { collectProjectStatus, formatProjectStatus } from "../diagnostics/status.js";

export interface GetStatusOutputOptions {
  cwd: string;
}

export async function getStatusOutput(options: GetStatusOutputOptions): Promise<string> {
  return formatProjectStatus(await collectProjectStatus(options));
}
