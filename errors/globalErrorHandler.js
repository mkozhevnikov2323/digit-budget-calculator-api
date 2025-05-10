const globalErrorHandler = (err, req, res, next) => {
  const status = err.statusCode || 500;
  const { message } = err;
  res.status(status).json({ err: message || 'На сервере произошла ошибка' });
  return next();
};

module.exports = globalErrorHandler;
