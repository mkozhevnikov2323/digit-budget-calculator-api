const express = require('express');
const bodyParser = require('body-parser');
const { errors } = require('celebrate');

const { requestLogger, errorLogger } = require('./middlewares/logger');
const cors = require('./middlewares/cors');
const globalErrorHandler = require('./errors/globalErrorHandler');
const routes = require('./routes');

const app = express();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(requestLogger);
app.use(cors);

app.use(routes);

app.use(errorLogger);
app.use(errors());
app.use(globalErrorHandler);

module.exports = app;
