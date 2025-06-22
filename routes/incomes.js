const router = require('express').Router();
const { celebrate, Joi } = require('celebrate');
const {
  getIncomes,
  addIncome,
  updateIncome,
  deleteIncome,
} = require('../controllers/incomes');

router.get('/', getIncomes);

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
