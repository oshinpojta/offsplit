export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'ApiError';
  }
}

export const unauthorized = () => new ApiError(401, 'unauthorized');
export const forbidden = (code = 'forbidden') => new ApiError(403, code);
export const notFound = (code = 'not_found') => new ApiError(404, code);
export const conflict = (code: string) => new ApiError(409, code);
export const badRequest = (code: string, message?: string) =>
  new ApiError(400, code, message);
/** T7/D3: invalid, expired and already-claimed tokens are indistinguishable. */
export const claimInvalid = () => new ApiError(404, 'claim_invalid');
