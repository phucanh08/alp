export class AlpError extends Error {
  declare code: string;
  constructor(code: string, message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AlpError';
    this.code = code;
  }
}
