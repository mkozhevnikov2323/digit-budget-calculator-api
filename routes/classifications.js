const router = require('express').Router();
const getClassification = require('../controllers/classificationRead');
const historyRead = require('../controllers/classificationHistoryRead');
const { classificationProtocol } = require('../services/classificationProtocol');

// Mounted only after the existing JWT guard. No write routes.
router.get('/:dataset/:operationId', getClassification);
router.post('/history/read', historyRead);
router.post('/:dataset/:operationId/reviews', classificationProtocol);
router.post('/:dataset/:operationId/commands', classificationProtocol);
router.post('/:dataset/:operationId/commands/reconcile', classificationProtocol);

module.exports = router;
