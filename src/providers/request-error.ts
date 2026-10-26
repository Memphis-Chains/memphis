/** Transport evidence without provider response bodies or request credentials. */
export class ProviderHttpError extends Error {
  constructor(readonly status: number) {
    super(`Provider HTTP ${status}`);
    this.name = 'ProviderHttpError';
  }
}
