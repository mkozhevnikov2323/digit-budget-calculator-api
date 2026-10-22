import express = require('express');
import bodyParser = require('body-parser');
import { errors } from 'celebrate';

import logger = require('./middlewares/logger');
import cors = require('./middlewares/cors');
import globalErrorHandler = require('./errors/globalErrorHandler');
// Transitional boundary: legacy routes/controllers/models remain unchecked.
import routes = require('./routes');
import { classificationTransport } from './middlewares/classificationTransport';

const app = express();

app.use(classificationTransport);
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(logger.requestLogger);
app.use(cors);

app.use(routes);

app.use(logger.errorLogger);
app.use(errors());
app.use(globalErrorHandler);

export = app;
