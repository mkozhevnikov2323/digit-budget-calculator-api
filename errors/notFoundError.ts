class NotFoundError extends Error {
  declare statusCode: number;

  constructor(message: string) {
    super(message);
    this.statusCode = 404;
  }
}

export = NotFoundError;
