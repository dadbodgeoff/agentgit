import { AuthorityClientTransportError, AuthorityDaemonResponseError } from "@agentgit/authority-sdk";

export const CLI_JSON_CONTRACT_VERSION = "agentgit.cli.output.v1";
export const CLI_EXIT_CODE_REGISTRY_VERSION = "agentgit.cli.exit-codes.v1";
export const CLI_CONFIG_SCHEMA_VERSION = "agentgit.cli.config.v1";

export const CLI_EXIT_CODES = {
  OK: 0,
  USAGE: 64,
  INPUT_INVALID: 65,
  NOT_FOUND: 66,
  UNAVAILABLE: 69,
  INTERNAL: 70,
  IO_ERROR: 74,
  TEMPORARY_FAILURE: 75,
  PERMISSION_DENIED: 77,
  CONFIG_ERROR: 78,
} as const;

export type CliExitCode = (typeof CLI_EXIT_CODES)[keyof typeof CLI_EXIT_CODES];

export interface CliErrorDetails {
  [key: string]: unknown;
}

export class CliError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly errorClass: string,
    public readonly exitCode: CliExitCode,
    public readonly retryable: boolean,
    public readonly details?: CliErrorDetails,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export interface CliJsonErrorEnvelope {
  ok: false;
  error: {
    code: string;
    error_class: string;
    message: string;
    retryable: boolean;
    exit_code: CliExitCode;
    details?: CliErrorDetails;
  };
}

export function usageError(usage: string, details?: CliErrorDetails): CliError {
  return new CliError(usage, "CLI_USAGE", "cli_usage", CLI_EXIT_CODES.USAGE, false, details);
}

export function inputError(message: string, details?: CliErrorDetails): CliError {
  return new CliError(message, "CLI_INPUT_INVALID", "cli_input", CLI_EXIT_CODES.INPUT_INVALID, false, details);
}

export function configError(message: string, details?: CliErrorDetails): CliError {
  return new CliError(message, "CLI_CONFIG_INVALID", "cli_config", CLI_EXIT_CODES.CONFIG_ERROR, false, details);
}

export function ioError(message: string, details?: CliErrorDetails): CliError {
  return new CliError(message, "CLI_IO_ERROR", "cli_io", CLI_EXIT_CODES.IO_ERROR, false, details);
}

export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }

  if (error instanceof AuthorityDaemonResponseError) {
    return new CliError(
      error.message,
      error.code,
      error.errorClass,
      mapDaemonErrorExitCode(error.code, error.retryable),
      error.retryable,
      error.details,
    );
  }

  if (error instanceof AuthorityClientTransportError) {
    return new CliError(
      error.message,
      error.code,
      "transport_error",
      mapTransportErrorExitCode(error.code, error.retryable),
      error.retryable,
      error.details,
    );
  }

  if (error instanceof SyntaxError) {
    return inputError(error.message);
  }

  if (error instanceof Error) {
    return new CliError(error.message, "CLI_INTERNAL_ERROR", "cli_internal", CLI_EXIT_CODES.INTERNAL, false);
  }

  return new CliError(String(error), "CLI_INTERNAL_ERROR", "cli_internal", CLI_EXIT_CODES.INTERNAL, false);
}

function mapDaemonErrorExitCode(code: string, retryable: boolean): CliExitCode {
  switch (code) {
    case "BAD_REQUEST":
    case "VALIDATION_FAILED":
      return CLI_EXIT_CODES.INPUT_INVALID;
    case "NOT_FOUND":
      return CLI_EXIT_CODES.NOT_FOUND;
    case "PRECONDITION_FAILED":
    case "POLICY_BLOCKED":
      return CLI_EXIT_CODES.PERMISSION_DENIED;
    case "CAPABILITY_UNAVAILABLE":
    case "BROKER_UNAVAILABLE":
    case "UPSTREAM_FAILURE":
      return retryable ? CLI_EXIT_CODES.TEMPORARY_FAILURE : CLI_EXIT_CODES.UNAVAILABLE;
    case "STORAGE_UNAVAILABLE":
      return CLI_EXIT_CODES.IO_ERROR;
    case "TIMEOUT":
      return CLI_EXIT_CODES.TEMPORARY_FAILURE;
    case "CONFLICT":
      return CLI_EXIT_CODES.INPUT_INVALID;
    case "INTERNAL_ERROR":
      return CLI_EXIT_CODES.INTERNAL;
    default:
      return retryable ? CLI_EXIT_CODES.TEMPORARY_FAILURE : CLI_EXIT_CODES.INTERNAL;
  }
}

function mapTransportErrorExitCode(code: string, retryable: boolean): CliExitCode {
  switch (code) {
    case "SOCKET_CONNECT_FAILED":
    case "SOCKET_CONNECT_TIMEOUT":
    case "SOCKET_CLOSED":
      return CLI_EXIT_CODES.UNAVAILABLE;
    case "SOCKET_RESPONSE_TIMEOUT":
      return CLI_EXIT_CODES.TEMPORARY_FAILURE;
    case "INVALID_RESPONSE":
      return CLI_EXIT_CODES.INTERNAL;
    default:
      return retryable ? CLI_EXIT_CODES.TEMPORARY_FAILURE : CLI_EXIT_CODES.INTERNAL;
  }
}

export function formatCliJsonError(error: CliError): CliJsonErrorEnvelope {
  return {
    ok: false,
    error: {
      code: error.code,
      error_class: error.errorClass,
      message: error.message,
      retryable: error.retryable,
      exit_code: error.exitCode,
      ...(error.details ? { details: error.details } : {}),
    },
  };
}
