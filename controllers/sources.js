const Source = require('../models/source');

module.exports.getSources = (req, res, next) => {
  Source.find({})
    .then((sources) => res.status(200).send(sources.map((s) => s.name)))
    .catch(next);
};

module.exports.addSource = (req, res, next) => {
  const { name } = req.body;

  Source.create({ name })
    .then(() => res.status(201).send())
    .catch((err) => {
      if (err.code === 11000) {
        return res.status(409).send({ message: 'Источник уже существует!' });
      }
      if (err.name === 'ValidationError') {
        return res
          .status(400)
          .send({ message: 'Невалидные данные источника!' });
      }
      return next(err);
    });
};
