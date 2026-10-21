const router = require('express').Router();
const getClassification = require('../controllers/classificationRead');

// Mounted only after the existing JWT guard. No write routes.
router.get('/:dataset/:operationId', getClassification);

module.exports = router;
