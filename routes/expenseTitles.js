const router = require('express').Router();
const { celebrate, Joi } = require('celebrate');
const {
  getExpenseTitles,
  addExpenseTitle,
} = require('../controllers/expenseTitles');

router.get('/', getExpenseTitles);

router.post(
  '/',
  celebrate({
    body: Joi.object().keys({
      name: Joi.string().required(),
    }),
  }),
  addExpenseTitle,
);

module.exports = router;
