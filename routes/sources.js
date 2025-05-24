const router = require('express').Router();
const { celebrate, Joi } = require('celebrate');
const {
  getDefaultSources,
  getUserSources,
  addUserSource,
} = require('../controllers/sources');
const auth = require('../middlewares/auth');

router.get('/default', getDefaultSources);

router.get('/user', getUserSources);

router.post(
  '/user',
  celebrate({
    body: Joi.object().keys({
      name: Joi.string().required(),
    }),
  }),
  addUserSource,
);

module.exports = router;
