const router = require('express').Router();
const { celebrate, Joi } = require('celebrate');
const { getSources, addSource } = require('../controllers/sources');

router.get('/', getSources);

router.post(
  '/',
  celebrate({
    body: Joi.object().keys({
      name: Joi.string().required(),
    }),
  }),
  addSource,
);

module.exports = router;
