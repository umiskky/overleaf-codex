import { redactSensitive } from "../cli-behavior.js";

export function redactForStatus(value: unknown): string {
  return redactSensitive(value);
}

export const redactAuth = redactForStatus;
export const redactConfig = redactForStatus;
