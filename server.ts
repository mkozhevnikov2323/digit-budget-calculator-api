import dotenv = require('dotenv');
dotenv.config();
// Validate HTTP configuration before application imports or connection side effects.
const portText = process.env.PORT ?? '3000';
if (/^[0-9]{1,5}$/.exec(portText)?.[0] !== portText || Number(portText) < 1 || Number(portText) > 65535) {
  throw new Error('PORT must be a decimal TCP port between 1 and 65535');
}
const port = Number(portText);
const host = process.env.BUDGET_HTTP_HOST;
if (host !== undefined && host !== '127.0.0.1') {
  throw new Error('BUDGET_HTTP_HOST must be absent or 127.0.0.1');
}
// Keep sequential CommonJS evaluation: dotenv runs before application imports.
import mongoose = require('mongoose');
import app = require('./app');

const {
  NODE_ENV,
  DATA_BASE_URL,
  DATA_BASE_URL_LOCAL,
} = process.env;
// Mongoose declares a string URI, but the legacy production path can pass
// undefined. This single erased assertion preserves the driver's own failure
// behavior; it adds no config validation, default, await or retry.
mongoose.connect(
  (NODE_ENV === 'production'
    ? DATA_BASE_URL
    : DATA_BASE_URL_LOCAL || 'mongodb://localhost:27017/budgetdb') as string,
);

const onListening = () => {
  console.log(`Сервер запущен на порту ${port}`);
};
if (host === '127.0.0.1') {
  app.listen(port, '127.0.0.1', onListening);
} else {
  // Preserve the host-omitted deployment behavior (e.g. Render).
  app.listen(port, onListening);
}
