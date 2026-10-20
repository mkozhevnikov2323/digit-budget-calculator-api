const router = require('express').Router();
const { celebrate, Joi } = require('celebrate');
const getRecurrence = require('../controllers/recurrence');

// Provisional read-only endpoint; requires the existing parent router JWT guard.
router.get('/', celebrate({
  query: Joi.object().keys({
    startMonth: Joi.string().pattern(/^\d{4}-(0[1-9]|1[0-2])$/).required(),
    endMonthExclusive: Joi.string().pattern(/^\d{4}-(0[1-9]|1[0-2])$/).required(),
  }),
}), getRecurrence);

module.exports = router;
