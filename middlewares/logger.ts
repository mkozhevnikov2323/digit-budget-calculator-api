import type { RequestHandler, ErrorRequestHandler } from 'express';
import winston = require('winston');
import expressWinston = require('express-winston');

const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'CONNECT', 'TRACE']);
const safeMethod = (value: unknown): string =>
  typeof value === 'string' && methods.has(value) ? value : 'OTHER';

const operationalFormat = (event: 'http_request' | 'http_error', level: 'info' | 'error') =>
  winston.format.combine(
    winston.format((info) => {
      // A fresh object is the final allowlist boundary. Never copy metadata,
      // toJSON methods or Winston MESSAGE/SPLAT symbols into the JSON formatter.
      const record: winston.Logform.TransformableInfo = {
        level,
        message: event,
        method: safeMethod(info.method),
        [Symbol.for('level')]: level,
      };
      if (event === 'http_request' && typeof info.statusCode === 'number'
        && Number.isInteger(info.statusCode) && info.statusCode >= 100 && info.statusCode <= 599) {
        record.statusCode = info.statusCode;
      }
      return record;
    })(),
    winston.format.json(),
  );

const requestLogger: RequestHandler = expressWinston.logger({
  transports: [new winston.transports.File({ filename: 'request.log' })],
  format: operationalFormat('http_request', 'info'),
  msg: 'http_request',
  metaField: null,
  requestField: null,
  responseField: null,
  requestWhitelist: [],
  responseWhitelist: [],
  dynamicMeta: (req, res) => ({ method: safeMethod(req.method), statusCode: res.statusCode }),
});

const errorLogger: ErrorRequestHandler = expressWinston.errorLogger({
  transports: [new winston.transports.File({ filename: 'error.log' })],
  format: operationalFormat('http_error', 'error'),
  msg: 'http_error',
  metaField: null,
  requestField: null,
  requestWhitelist: [],
  // express-winston invokes this even with meta:false. Never serialize err.
  exceptionToMeta: () => ({}),
  // The global handler has not selected the final status yet; request.log will
  // record it after res.end. Do not report a misleading error status here.
  dynamicMeta: (req) => ({ method: safeMethod(req.method) }),
});

export = {
  requestLogger,
  errorLogger,
};
