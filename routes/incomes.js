const router = require('express').Router();
const { celebrate, Joi } = require('celebrate');
const {
  getIncomes,
  addIncome,
  updateIncome,
  deleteIncome,
} = require('../controllers/incomes');

router.get(
  '/',
  celebrate({
    query: Joi.object().keys({
      startDate: Joi.date().iso(),
      endDate: Joi.date().iso(),
      month: Joi.number().integer().min(1).max(12),
      year: Joi.number().integer().min(2020),
      source: Joi.string(),
      page: Joi.number().integer().min(1),
      limit: Joi.number().integer().min(1).max(100),
      noPagination: Joi.boolean().default(false),
      _summary: Joi.boolean(),
    }),
  }),
  getIncomes,
);

router.post(
  '/',
  celebrate({
    body: Joi.object().keys({
      source: Joi.string().required(),
      amount: Joi.number().required().min(0),
      date: Joi.date().required(),
      comment: Joi.string().allow('', null),
    }),
  }),
  addIncome,
);

router.patch(
  '/:id',
  celebrate({
    params: Joi.object().keys({
      id: Joi.string().hex().length(24),
    }),
    body: Joi.object().keys({
      source: Joi.string(),
      amount: Joi.number().min(0),
      date: Joi.date(),
      comment: Joi.string().allow('', null),
    }),
  }),
  updateIncome,
);

router.delete(
  '/:id',
  celebrate({
    params: Joi.object().keys({
      id: Joi.string().hex().length(24),
    }),
  }),
  deleteIncome,
);

module.exports = router;
