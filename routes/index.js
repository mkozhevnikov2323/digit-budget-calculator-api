const router = require('express').Router();
const auth = require('../middlewares/auth');
const NotFoundError = require('../errors/notFoundError');

router.use(require('./auth'));

router.use(auth);
router.use(require('./users'));

// incomes
router.use('/incomes', require('./incomes'));
router.use('/sources', require('./sources'));

// expenses
router.use('/expenses', require('./expenses'));
router.use('/categories', require('./expenseCategories'));
router.use('/recipients', require('./recipients'));

// balance
router.use('/balance', require('./balance'));

router.use((req, res, next) => {
  next(new NotFoundError('Страница не найдена!'));
});

module.exports = router;
