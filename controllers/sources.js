const SourceDefault = require('../models/sourceDefault');
const SourceUser = require('../models/sourceUser');

module.exports.getDefaultSources = (req, res, next) => {
  SourceDefault.find({})
    .then((sources) =>
      res.status(200).send(sources.map(({ _id, name }) => ({ id: _id, name }))),
    )
    .catch(next);
};

module.exports.getUserSources = (req, res, next) => {
  SourceUser.find({ owner: req.user._id })
    .then((sources) =>
      res.status(200).send(sources.map(({ _id, name }) => ({ id: _id, name }))),
    )
    .catch(next);
};

module.exports.addUserSource = (req, res, next) => {
  const { name } = req.body;
  SourceUser.create({ name, owner: req.user._id })
    .then((doc) => res.status(201).send({ id: doc._id, name: doc.name }))
    .catch((err) => {
      if (err.code === 11000) {
        return res
          .status(409)
          .send({ message: 'У вас уже есть такой источник!' });
      }
      if (err.name === 'ValidationError') {
        return res
          .status(400)
          .send({ message: 'Невалидные данные источника!' });
      }
      return next(err);
    });
};
