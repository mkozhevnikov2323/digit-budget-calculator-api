const router = require('express').Router();
const { celebrate, Joi } = require('celebrate');
const { getExpenses, addExpense } = require('../controllers/expenses');

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

module.exports = router;
