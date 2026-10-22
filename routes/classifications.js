const router = require('express').Router();
const getClassification = require('../controllers/classificationRead');
const historyRead = require('../controllers/classificationHistoryRead');

// Mounted only after the existing JWT guard. No write routes.
router.get('/:dataset/:operationId', getClassification);
router.post('/history/read', historyRead);

module.exports = router;
