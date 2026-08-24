/** Error carrying an HTTP status and optional recovery payload. */
export class ApiError extends Error {
  status: number
  hint?: string
  extra?: Record<string, unknown>

  constructor(status: number, message: string, hint?: string, extra?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.hint = hint
    this.extra = extra
  }
}

export function badRequest(message: string, hint?: string): ApiError {
  return new ApiError(400, message, hint)
}

export function notFound(message: string, hint?: string): ApiError {
  return new ApiError(404, message, hint)
}

export function unauthorized(message: string, hint?: string): ApiError {
  return new ApiError(401, message, hint)
}

export function forbidden(message: string, hint?: string): ApiError {
  return new ApiError(403, message, hint)
}

export function conflict(
  message: string,
  hint?: string,
  extra?: Record<string, unknown>,
): ApiError {
  return new ApiError(409, message, hint, extra)
}

export function tooMany(message: string): ApiError {
  return new ApiError(429, message)
}
