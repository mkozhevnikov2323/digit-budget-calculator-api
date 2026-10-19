import type { RequestHandler, ErrorRequestHandler } from 'express';
import winston = require('winston');
import expressWinston = require('express-winston');

const requestLogger: RequestHandler = expressWinston.logger({
  transports: [new winston.transports.File({ filename: 'request.log' })],
  format: winston.format.json(),
});

const errorLogger: ErrorRequestHandler = expressWinston.errorLogger({
  transports: [new winston.transports.File({ filename: 'error.log' })],
  format: winston.format.json(),
});

export = {
  requestLogger,
  errorLogger,
};
