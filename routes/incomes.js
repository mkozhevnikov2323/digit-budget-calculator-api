const router = require('express').Router();
const { celebrate, Joi } = require('celebrate');
const { getIncomes, addIncome } = require('../controllers/incomes');

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

module.exports = router;
