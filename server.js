require('dotenv').config();
const mongoose = require('mongoose');
const app = require('./app');

const {
  PORT = 3000,
  NODE_ENV,
  DATA_BASE_URL,
  DATA_BASE_URL_LOCAL,
} = process.env;
mongoose.connect(
  NODE_ENV === 'production'
    ? DATA_BASE_URL
    : DATA_BASE_URL_LOCAL || 'mongodb://localhost:27017/budgetdb',
);

app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
