const router = require('express').Router();
const { celebrate, Joi } = require('celebrate');
const { getRecipients, addRecipient } = require('../controllers/recipients');

router.get('/', getRecipients);

router.post(
  '/',
  celebrate({
    body: Joi.object().keys({
      name: Joi.string().required(),
    }),
  }),
  addRecipient,
);

module.exports = router;
