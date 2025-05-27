const Recipient = require('../models/recipient');

module.exports.getRecipients = (req, res, next) => {
  Recipient.find({ owner: req.user._id })
    .then((recipients) =>
      res
        .status(200)
        .send(recipients.map(({ _id, name }) => ({ id: _id, name }))),
    )
    .catch(next);
};

module.exports.addRecipient = (req, res, next) => {
  const { name } = req.body;

  Recipient.create({ name, owner: req.user._id })
    .then((doc) => res.status(201).send({ id: doc._id, name: doc.name }))
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
