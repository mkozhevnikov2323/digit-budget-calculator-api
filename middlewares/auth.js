const jwt = require('jsonwebtoken');
const AuthorizationError = require('../errors/authorizationError');

module.exports = (req, res, next) => {
  const { authorization } = req.headers;
  if (!authorization || !authorization.startsWith('Bearer ')) {
    return next(new AuthorizationError('Необходима авторизация.'));
  }

  const token = authorization.replace('Bearer ', '');
  try {
    const payload = jwt.verify(
      token,
      process.env.NODE_ENV === 'production'
        ? process.env.JWT_SECRET
        : 'super-secret-key',
    );
    req.user = payload;
    return next();
  } catch (err) {
    return next(new AuthorizationError('Необходима авторизация!'));
  }
};
