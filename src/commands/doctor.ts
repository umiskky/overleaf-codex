import { formatDoctorReport, runDoctorDiagnostics } from "../diagnostics/doctor.js";
import type { ExitCode } from "../errors.js";

export interface GetDoctorOutputOptions {
  cwd: string;
  nodeVersion?: string;
  backendAvailable?: boolean;
}

export interface DoctorCommandOutput {
  exitCode: ExitCode;
  output: string;
}

export async function getDoctorOutput(options: GetDoctorOutputOptions): Promise<DoctorCommandOutput> {
  const report = await runDoctorDiagnostics(options);
  return {
    exitCode: report.exitCode,
    output: formatDoctorReport(report),
  };
}
