class AuthorizationError extends Error {
  declare statusCode: number;

  constructor(message: string) {
    super(message);
    this.statusCode = 401;
  }
}

export = AuthorizationError;
