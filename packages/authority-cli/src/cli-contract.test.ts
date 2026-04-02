import { describe, expect, it } from "vitest";

import { AuthorityClientTransportError, AuthorityDaemonResponseError } from "@agentgit/authority-sdk";

import {
  CLI_EXIT_CODES,
  CliError,
  configError,
  formatCliJsonError,
  inputError,
  toCliError,
  usageError,
} from "./cli-contract.js";

describe("cli contract", () => {
  it("preserves existing CliError instances", () => {
    const error = usageError("Usage: agentgit-authority ping");

    expect(toCliError(error)).toBe(error);
  });

  it("maps daemon response errors to stable exit codes", () => {
    const error = new AuthorityDaemonResponseError("Approval required", "POLICY_BLOCKED", "policy_error", false, {
      action_id: "act_123",
    });

    const cliError = toCliError(error);

    expect(cliError).toBeInstanceOf(CliError);
    expect(cliError.code).toBe("POLICY_BLOCKED");
    expect(cliError.exitCode).toBe(CLI_EXIT_CODES.PERMISSION_DENIED);
    expect(formatCliJsonError(cliError)).toEqual({
      ok: false,
      error: {
        code: "POLICY_BLOCKED",
        error_class: "policy_error",
        message: "Approval required",
        retryable: false,
        exit_code: CLI_EXIT_CODES.PERMISSION_DENIED,
        details: {
          action_id: "act_123",
        },
      },
    });
  });

  it("maps transport errors to availability-oriented exit codes", () => {
    const connectError = new AuthorityClientTransportError("Could not connect", "SOCKET_CONNECT_FAILED", true, {
      socket_path: "/tmp/authority.sock",
    });
    const timeoutError = new AuthorityClientTransportError("Timed out", "SOCKET_RESPONSE_TIMEOUT", true);

    expect(toCliError(connectError).exitCode).toBe(CLI_EXIT_CODES.UNAVAILABLE);
    expect(toCliError(timeoutError).exitCode).toBe(CLI_EXIT_CODES.TEMPORARY_FAILURE);
  });

  it("maps syntax and generic errors to input or internal cli errors", () => {
    expect(toCliError(new SyntaxError("Unexpected token")).exitCode).toBe(CLI_EXIT_CODES.INPUT_INVALID);
    expect(toCliError(new Error("boom")).exitCode).toBe(CLI_EXIT_CODES.INTERNAL);
    expect(toCliError("boom").exitCode).toBe(CLI_EXIT_CODES.INTERNAL);
  });

  it("creates explicit config and input errors with stable metadata", () => {
    const cliConfigError = configError("Bad config", { path: "/tmp/config.toml" });
    const cliInputError = inputError("Bad input", { field: "workspace_root" });

    expect(cliConfigError.code).toBe("CLI_CONFIG_INVALID");
    expect(cliConfigError.exitCode).toBe(CLI_EXIT_CODES.CONFIG_ERROR);
    expect(cliInputError.code).toBe("CLI_INPUT_INVALID");
    expect(cliInputError.exitCode).toBe(CLI_EXIT_CODES.INPUT_INVALID);
  });
});
