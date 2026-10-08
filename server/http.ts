import type { ErrorCode } from '../shared/errors.ts';

// The one error type routes and providers throw; the router turns it into a JSON response.
export class HttpError extends Error {
  readonly status: number;
  readonly code?: ErrorCode;
  constructor(status: number, message: string, code?: ErrorCode) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const notFound = (what = 'not found'): HttpError => new HttpError(404, what, 'MEDIA_NOT_FOUND');
