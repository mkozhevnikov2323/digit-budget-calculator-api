import type { RequestHandler } from 'express';
import jwt = require('jsonwebtoken');
import AuthorizationError = require('../errors/authorizationError');

// Syntactic claim only: this proves neither account existence nor ownership.
const hasValidOwnerClaim = (payload: unknown): payload is { _id: string } => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)
    || !('_id' in payload)) return false;

  return Object.hasOwn(payload, '_id')
    && typeof payload._id === 'string'
    // JavaScript $ also matches before a final newline; require exact length.
    && payload._id.length === 24
    && /^[a-fA-F0-9]{24}$/.test(payload._id);
};

const auth: RequestHandler = (req, res, next) => {
  const { authorization } = req.headers;
  if (!authorization || !authorization.startsWith('Bearer ')) {
    return next(new AuthorizationError('Необходима авторизация.'));
  }

  const token = authorization.replace('Bearer ', '');
  try {
    const payload: unknown = jwt.verify(
      token,
      // Erased assertion: preserve an absent production secret at runtime.
      // jsonwebtoken rejects it; no fallback or startup validation is added.
      (process.env.NODE_ENV === 'production'
        ? process.env.JWT_SECRET
        : 'super-secret-key') as jwt.Secret,
    );
    if (!hasValidOwnerClaim(payload)) {
      return next(new AuthorizationError('Необходима авторизация!'));
    }
    req.user = payload;
    return next();
  } catch (err) {
    return next(new AuthorizationError('Необходима авторизация!'));
  }
};

export = auth;
