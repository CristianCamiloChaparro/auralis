/** Error controlado: llega al cliente con un código estable y un mensaje legible. */
export class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
