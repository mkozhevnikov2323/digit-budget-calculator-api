const { classificationC } = require('../services/classificationC');
const router = require('express').Router();
const getClassification = require('../controllers/classificationRead');
const historyRead = require('../controllers/classificationHistoryRead');
const { classificationProtocol } = require('../services/classificationProtocol');

// Mounted only after the existing JWT guard. C is independently default-off.
router.get('/:dataset/:operationId', getClassification);
router.post('/history/read', historyRead);
router.post('/:dataset/:operationId/reviews', classificationProtocol);
router.post('/:dataset/:operationId/commands', classificationProtocol);
router.post('/:dataset/:operationId/commands/reconcile', classificationProtocol);

for (const action of ['prepare', 'apply', 'reconcile'])
  router.post('/:dataset/:operationId/c-v1/' + action, classificationC);

module.exports = router;
