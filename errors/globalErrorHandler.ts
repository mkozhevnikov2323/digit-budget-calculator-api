import type { ErrorRequestHandler } from 'express';

// Legacy middleware supplies structural metadata, not necessarily an Error.
// This assertion is erased: preserve property access, truthiness and messages
// exactly, without introducing guards or status-code/response normalization.
type LegacyErrorMetadata = { statusCode?: number; message?: string };

const globalErrorHandler: ErrorRequestHandler = (err: unknown, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  const metadata = err as LegacyErrorMetadata;
  const status = metadata.statusCode || 500;
  const { message } = metadata;
  res.status(status).send({
    message: status === 500 ? 'На сервере произошла ошибка' : message,
  });
};

export = globalErrorHandler;
