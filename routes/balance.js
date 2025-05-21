const router = require('express').Router();
const { getBalance } = require('../controllers/balance');

router.get('/', getBalance);

module.exports = router;
