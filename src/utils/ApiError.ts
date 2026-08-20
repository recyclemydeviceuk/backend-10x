/** Throw anywhere in a handler — the error middleware turns it into JSON. */
export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }

  static badRequest(message: string) {
    return new ApiError(400, message);
  }
  static unauthorized(message = 'Not signed in.') {
    return new ApiError(401, message);
  }
  static forbidden(message = 'Your role does not allow this.') {
    return new ApiError(403, message);
  }
  static notFound(message = 'Not found.') {
    return new ApiError(404, message);
  }
  static conflict(message: string) {
    return new ApiError(409, message);
  }
}
