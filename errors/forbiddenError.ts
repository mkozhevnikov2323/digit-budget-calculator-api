class ForbiddenError extends Error {
  declare statusCode: number;

  constructor(message: string) {
    super(message);
    this.statusCode = 403;
  }
}

export = ForbiddenError;
