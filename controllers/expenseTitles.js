const ExpenseTitle = require('../models/expenseTitle');

module.exports.getExpenseTitles = (req, res, next) => {
  ExpenseTitle.find({ owner: req.user._id })
    .then((titles) =>
      res.status(200).send(titles.map(({ _id, name }) => ({ id: _id, name }))),
    )
    .catch(next);
};

module.exports.addExpenseTitle = (req, res, next) => {
  const { name } = req.body;

  ExpenseTitle.create({ name, owner: req.user._id })
    .then((doc) => res.status(201).send({ id: doc._id, name: doc.name }))
    .catch((err) => {
      if (err.code === 11000) {
        return res
          .status(409)
          .send({ message: 'Наименование уже существует!' });
      }
      if (err.name === 'ValidationError') {
        return res
          .status(400)
          .send({ message: 'Невалидные данные наименования расхода!' });
      }
      return next(err);
    });
};
