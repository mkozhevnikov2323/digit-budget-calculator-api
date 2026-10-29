/** Narrow transport policy for the approved new POST protocol only. */
import type { RequestHandler } from 'express';
import bodyParser = require('body-parser');
import { sendClassificationHttpError } from '../services/classificationHttpError';

export const isClassificationPost = (method: string, path: string): boolean => method === 'POST'
  && (/^\/classifications\/history\/read\/?$/.test(path)
    || /^\/classifications\/[^/]+\/[^/]+\/(reviews|commands|commands\/reconcile|c-v1\/(?:prepare|apply|reconcile))\/?$/.test(path));

/** Validate JSON syntax first, then scan its tokens to reject duplicate decoded
 * object keys (including escaped aliases). Bounded input/depth; never echo text. */
export const parseClassificationJson = (text: string): unknown => {
  const value: unknown = JSON.parse(text);
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g) ?? [];
  let at = 0;
  const walk = (depth: number): void => {
    if (depth > 16) throw new Error('Invalid JSON');
    const token = tokens[at++];
    if (token === '{') {
      const keys = new Set<string>();
      if (tokens[at] === '}') { at++; return; }
      do {
        const key: unknown = JSON.parse(tokens[at++]);
        if (typeof key !== 'string' || keys.has(key) || tokens[at++] !== ':') throw new Error('Invalid JSON');
        keys.add(key); walk(depth + 1);
        if (tokens[at] !== ',') break;
        at++;
      } while (at < tokens.length);
      if (tokens[at++] !== '}') throw new Error('Invalid JSON');
    } else if (token === '[') {
      if (tokens[at] === ']') { at++; return; }
      do { walk(depth + 1); if (tokens[at] !== ',') break; at++; } while (at < tokens.length);
      if (tokens[at++] !== ']') throw new Error('Invalid JSON');
    }
  };
  walk(0);
  if (at !== tokens.length) throw new Error('Invalid JSON');
  return value;
};
const parser = bodyParser.text({ type: 'application/json', limit: 8192, inflate: false, defaultCharset: 'utf-8' });
const origins = ['https://digit-budget-calculator.onrender.com', 'http://localhost:5173'];
export const classificationTransport: RequestHandler = (req, res, next) => {
  if (!isClassificationPost(req.method, req.path)) { next(); return; }
  res.set('Cache-Control', 'no-store'); res.vary('Authorization'); res.vary('Origin');
  const end = res.end;
  res.end = function (this: typeof res, ...args: Parameters<typeof res.end>) {
    if (!this.headersSent) this.removeHeader('ETag');
    return Reflect.apply(end, this, args);
  } as typeof res.end;
  // Express send checks freshness for GET/HEAD only; never emit an ETag here.
  const send = (status: number, code: string) => {
    if (/^\/classifications\/history\/read\/?$/.test(req.path)) res.status(status).json({ code });
    else sendClassificationHttpError(res, status, status === 403 ? 'forbidden_origin' : status === 413 ? 'request_too_large'
      : status === 415 ? 'unsupported_media_type' : 'invalid_request');
  };
  if (req.headers.origin !== undefined && !origins.includes(req.headers.origin)) { send(403, 'origin_rejected'); return; }
  if (!req.is('application/json')) { send(415, 'json_required'); return; }
  parser(req, res, error => {
    if (error) { send(error.status === 413 ? 413 : error.status === 415 ? 415 : 400, 'invalid_request'); return; }
    try {
      if (typeof req.body !== 'string') throw new Error('Invalid JSON');
      req.body = parseClassificationJson(req.body);
      next();
    } catch { send(400, 'invalid_request'); }
  });
};
