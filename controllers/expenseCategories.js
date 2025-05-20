const ExpenseCategory = require('../models/expenseCategory');

module.exports.getCategories = (req, res, next) => {
  ExpenseCategory.find({})
    .then((categories) => res.send(categories.map((c) => c.name)))
    .catch(next);
};

module.exports.addCategory = (req, res, next) => {
  const { name } = req.body;

  ExpenseCategory.create({ name })
    .then(() => res.status(201).send())
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
