const router = require('express').Router();
const { celebrate, Joi } = require('celebrate');
const {
  getDefaultCategories,
  getUserCategories,
  addUserCategory,
} = require('../controllers/expenseCategories');

router.get('/default', getDefaultCategories);

router.get('/user', getUserCategories);

router.post(
  '/user',
  celebrate({
    body: Joi.object().keys({
      name: Joi.string().required(),
    }),
  }),
  addUserCategory,
);

module.exports = router;
