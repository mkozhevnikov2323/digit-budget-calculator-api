import express = require('express');
import bodyParser = require('body-parser');
import { errors } from 'celebrate';

// Transitional boundary: these existing JS modules remain unchecked (checkJs:false).
import { requestLogger, errorLogger } from './middlewares/logger';
import cors = require('./middlewares/cors');
import globalErrorHandler = require('./errors/globalErrorHandler');
import routes = require('./routes');

const app = express();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(requestLogger);
app.use(cors);

app.use(routes);

app.use(errorLogger);
app.use(errors());
app.use(globalErrorHandler);

export = app;
