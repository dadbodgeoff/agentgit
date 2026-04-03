import fs from "node:fs";

import { inputError } from "../cli-contract.js";

const VISIBILITY_SCOPES = new Set(["user", "model", "internal", "sensitive_internal"]);

export function shiftCommandValue(args: string[], flag: string): string {
  const value = args.shift();
  if (!value || value.startsWith("--")) {
    throw inputError(`${flag} requires a value.`, {
      flag,
    });
  }

  return value;
}

export function parseIntegerFlag(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw inputError(`${flag} expects a non-negative integer.`, {
      flag,
      value,
    });
  }

  return parsed;
}

export function parseVisibilityScopeArg(
  value: string | undefined,
): "user" | "model" | "internal" | "sensitive_internal" | undefined {
  return value && VISIBILITY_SCOPES.has(value)
    ? (value as "user" | "model" | "internal" | "sensitive_internal")
    : undefined;
}

export function parseJsonArgOrFile(value: string): unknown {
  const source = fs.existsSync(value) ? fs.readFileSync(value, "utf8") : value;
  return JSON.parse(source);
}
