const router = require('express').Router();
const { celebrate, Joi } = require('celebrate');
const {
  getExpenses,
  addExpense,
  updateExpense,
  deleteExpense,
} = require('../controllers/expenses');

router.get('/', getExpenses);

router.post(
  '/',
  celebrate({
    body: Joi.object().keys({
      amount: Joi.number().required().min(0),
      date: Joi.date().required(),
      title: Joi.string().required(),
      recipient: Joi.string().required(),
      category: Joi.string().required(),
      comment: Joi.string().allow('', null),
    }),
  }),
  addExpense,
);

router.patch(
  '/:id',
  celebrate({
    params: Joi.object().keys({
      id: Joi.string().hex().length(24),
    }),
    body: Joi.object().keys({
      amount: Joi.number().min(0),
      date: Joi.date(),
      title: Joi.string(),
      recipient: Joi.string(),
      category: Joi.string(),
      comment: Joi.string().allow('', null),
    }),
  }),
  updateExpense,
);

router.delete(
  '/:id',
  celebrate({
    params: Joi.object().keys({
      id: Joi.string().hex().length(24),
    }),
  }),
  deleteExpense,
);

module.exports = router;
