import dotenv = require('dotenv');
dotenv.config();
// Keep sequential CommonJS evaluation: dotenv runs before application imports.
import mongoose = require('mongoose');
import app = require('./app');

const {
  PORT = 3000,
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

app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
