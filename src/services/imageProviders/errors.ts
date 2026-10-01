/** Provider failure with the HTTP status and message to return to the client. */
export class ImageProviderError extends Error {
  readonly status: number;
  readonly code: string;
  /** Raw provider error for server logs only; may contain project IDs. */
  readonly detail?: string;

  constructor(message: string, status: number, code: string, detail?: string) {
    super(message);
    this.name = "ImageProviderError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export function isImageProviderError(err: unknown): err is ImageProviderError {
  return err instanceof ImageProviderError;
}
