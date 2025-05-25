const ExpenseCategoryDefault = require('../models/expenseCategoryDefault');
const ExpenseCategoryUser = require('../models/expenseCategoryUser');

module.exports.getDefaultCategories = (req, res, next) => {
  ExpenseCategoryDefault.find({})
    .then((categories) =>
      res
        .status(200)
        .send(categories.map(({ _id, name }) => ({ id: _id, name }))),
    )
    .catch(next);
};

module.exports.getUserCategories = (req, res, next) => {
  ExpenseCategoryUser.find({ owner: req.user._id })
    .then((categories) =>
      res
        .status(200)
        .send(categories.map(({ _id, name }) => ({ id: _id, name }))),
    )
    .catch(next);
};

module.exports.addUserCategory = (req, res, next) => {
  const { name } = req.body;

  ExpenseCategoryUser.create({ name, owner: req.user._id })
    .then((doc) => res.status(201).send({ id: doc._id, name: doc.name }))
    .catch((err) => {
      if (err.code === 11000) {
        return res.status(409).send({ message: 'Категория уже существует!' });
      }
      if (err.name === 'ValidationError') {
        return res
          .status(400)
          .send({ message: 'Невалидные данные категории!' });
      }
      return next(err);
    });
};
