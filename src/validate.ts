// Input validation — aligned with gitmode patterns
//
// Validates paths, workspace IDs, and payload sizes at system boundaries.
// Internal code trusts validated inputs.

const MAX_PATH_LENGTH = 4096;
const MAX_PATH_DEPTH = 256;
const MAX_PAYLOAD_BYTES = 100 * 1024 * 1024; // 100MB
const MAX_COMMAND_LENGTH = 8192;
const VALID_WORKSPACE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

export function validatePath(path: string): void {
  if (path.length > MAX_PATH_LENGTH) {
    throw new ValidationError(
      `Path exceeds maximum length of ${MAX_PATH_LENGTH}`,
      "ENAMETOOLONG",
    );
  }

  if (path.includes("\0")) {
    throw new ValidationError(
      "Path contains null byte",
      "EINVAL",
    );
  }

  // Check for traversal after normalization
  const segments = path.split("/");
  if (segments.length > MAX_PATH_DEPTH) {
    throw new ValidationError(
      `Path exceeds maximum depth of ${MAX_PATH_DEPTH}`,
      "ENAMETOOLONG",
    );
  }

  // Ensure no segment is ".." after normalization (defense in depth)
  const normalized: string[] = [];
  for (const seg of segments) {
    if (seg === "..") {
      if (normalized.length === 0) {
        throw new ValidationError(
          "Path traversal above root is not allowed",
          "EACCES",
        );
      }
      normalized.pop();
    } else if (seg !== "" && seg !== ".") {
      normalized.push(seg);
    }
  }
}

export function validateWorkspaceId(id: string): void {
  if (!id || !VALID_WORKSPACE_ID.test(id)) {
    throw new ValidationError(
      `Invalid workspace ID: must match ${VALID_WORKSPACE_ID}`,
      "EINVAL",
    );
  }
}

export function validateCommand(command: string): void {
  if (!command || command.length === 0) {
    throw new ValidationError("Empty command", "EINVAL");
  }
  if (command.length > MAX_COMMAND_LENGTH) {
    throw new ValidationError(
      `Command exceeds maximum length of ${MAX_COMMAND_LENGTH}`,
      "EINVAL",
    );
  }
  if (command.includes("\0")) {
    throw new ValidationError("Command contains null byte", "EINVAL");
  }
}

export function validatePayloadSize(contentLength: string | null): void {
  if (contentLength) {
    const size = parseInt(contentLength, 10);
    if (size > MAX_PAYLOAD_BYTES) {
      throw new ValidationError(
        `Payload exceeds maximum size of ${MAX_PAYLOAD_BYTES} bytes`,
        "E2BIG",
      );
    }
  }
}
