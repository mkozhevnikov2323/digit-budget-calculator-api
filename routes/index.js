const router = require('express').Router();
const auth = require('../middlewares/auth');
const NotFoundError = require('../errors/notFoundErr');

router.use(require('./auth'));

router.use(auth);
router.use(require('./users'));
// router.use(require('./movies'));

router.all('/*', () => {
  throw new NotFoundError('Страница не найдена!');
});

module.exports = router;
