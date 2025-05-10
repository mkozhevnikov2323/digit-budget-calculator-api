const jwt = require('jsonwebtoken');
const AuthorizationError = require('../errors/authorizationError');

module.exports = (req, res, next) => {
  const { authorization } = req.headers;

  if (!authorization || !authorization.startsWith('Bearer ')) {
    throw new AuthorizationError('Необходима авторизация!!!');
  }

  const token = authorization.replace('Bearer ', '');
  let payload;

  try {
    const { NODE_ENV, JWT_SECRET } = process.env;
    payload = jwt.verify(
      token,
      NODE_ENV === 'production' ? JWT_SECRET : 'super-secret-key',
    );
  } catch (err) {
    throw new AuthorizationError('Необходима авторизация!');
  }
  req.user = payload;
  next();
};
