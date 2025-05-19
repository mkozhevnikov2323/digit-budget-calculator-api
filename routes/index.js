const router = require('express').Router();
const auth = require('../middlewares/auth');
const NotFoundError = require('../errors/notFoundError');

router.use(require('./auth'));

router.use(auth);
router.use(require('./users'));

router.use((req, res, next) => {
  next(new NotFoundError('Страница не найдена!'));
});

module.exports = router;
