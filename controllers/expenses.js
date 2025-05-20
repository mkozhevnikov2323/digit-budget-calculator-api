const Expense = require('../models/expense');

module.exports.getExpenses = (req, res, next) => {
  Expense.find({ owner: req.user._id })
    .then((expenses) => res.status(200).send(expenses))
    .catch(next);
};

module.exports.addExpense = (req, res, next) => {
  const { amount, date, title, recipient, category, comment } = req.body;

  Expense.create({
    amount,
    date,
    title,
    recipient,
    category,
    comment,
    owner: req.user._id,
  })
    .then(() => res.status(201).send())
    .catch((err) => {
      if (err.name === 'ValidationError') {
        return res.status(400).send({ message: 'Невалидные данные расхода!' });
      }
      return next(err);
    });
};
