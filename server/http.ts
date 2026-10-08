// The one error type routes and providers throw; the router turns it into a JSON response.
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const notFound = (what = 'not found'): HttpError => new HttpError(404, what);
