import type { RequestHandler } from 'express';
import jwt = require('jsonwebtoken');
import AuthorizationError = require('../errors/authorizationError');

const auth: RequestHandler = (req, res, next) => {
  const { authorization } = req.headers;
  if (!authorization || !authorization.startsWith('Bearer ')) {
    return next(new AuthorizationError('Необходима авторизация.'));
  }

  const token = authorization.replace('Bearer ', '');
  try {
    const payload = jwt.verify(
      token,
      // Erased assertion: preserve an absent production secret at runtime.
      // jsonwebtoken rejects it; no fallback or startup validation is added.
      (process.env.NODE_ENV === 'production'
        ? process.env.JWT_SECRET
        : 'super-secret-key') as jwt.Secret,
    );
    req.user = payload;
    return next();
  } catch (err) {
    return next(new AuthorizationError('Необходима авторизация!'));
  }
};

export = auth;
