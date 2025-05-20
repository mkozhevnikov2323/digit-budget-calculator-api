const Recipient = require('../models/recipient');

module.exports.getRecipients = (req, res, next) => {
  Recipient.find({})
    .then((recipients) => res.send(recipients.map((r) => r.name)))
    .catch(next);
};

module.exports.addRecipient = (req, res, next) => {
  const { name } = req.body;

  Recipient.create({ name })
    .then(() => res.status(201).send())
    .catch((err) => {
      if (err.code === 11000) {
        return res.status(409).send({ message: 'Получатель уже существует!' });
      }
      if (err.name === 'ValidationError') {
        return res
          .status(400)
          .send({ message: 'Невалидные данные получателя!' });
      }
      return next(err);
    });
};
