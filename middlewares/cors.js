const allowedCors = [
  // 'https://movies.m23.nomoredomains.xyz',
  // 'http://movies.m23.nomoredomains.xyz',
  'http://localhost:3000',
];

const { DEFAULT_ALLOWED_METHODS } = process.env;

module.exports = (req, res, next) => {
  const { origin } = req.headers;
  const { method } = req;

  const requestHeaders = req.headers['access-control-request-headers'];

  if (allowedCors.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }

  if (method === 'OPTIONS') {
    res.header('Access-Control-Allow-Methods', DEFAULT_ALLOWED_METHODS);
    res.header('Access-Control-Allow-Headers', requestHeaders);
    res.end();
  }

  next();
};
