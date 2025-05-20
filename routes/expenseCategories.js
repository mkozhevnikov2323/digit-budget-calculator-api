const router = require('express').Router();
const { celebrate, Joi } = require('celebrate');
const {
  getCategories,
  addCategory,
} = require('../controllers/expenseCategories');

router.get('/', getCategories);

router.post(
  '/',
  celebrate({
    body: Joi.object().keys({
      name: Joi.string().required(),
    }),
  }),
  addCategory,
);

module.exports = router;
