export type RuntimeErrorCode =
  | "BACKGROUND_INVALID"
  | "BACKGROUND_MISSING"
  | "THEME_PACKAGE_LIMIT"
  | "THEME_PACKAGE_INVALID"
  | "APPEARANCE_CORRUPT"
  | "APPEARANCE_STALE"
  | "APPEARANCE_LIMIT"
  | "THEME_MISSING"
  | "GENERAL_STALE"
  | "GENERAL_FAILED"
  | "INVALID_GENERAL"
  | "HOST_EXITED"
  | "HOST_NOT_READY"
  | "HOST_PROTOCOL_ERROR"
  | "HOST_TIMEOUT"
  | "IPC_FORBIDDEN"
  | "INVALID_PAYLOAD"
  | "INVALID_APPEARANCE"
  | "APPEARANCE_FAILED";

export class PublicError extends Error {
  public readonly code: RuntimeErrorCode;

  public constructor(code: RuntimeErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "PublicError";
    this.code = code;
  }
}

export const toSafeError = (error: unknown): { code: string; message: string } => {
  if (error instanceof PublicError) {
    return {
      code: error.code,
      message: error.message.replace(/^\[[^\]]+\]\s*/, ""),
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message: "An internal runtime error occurred",
  };
};
