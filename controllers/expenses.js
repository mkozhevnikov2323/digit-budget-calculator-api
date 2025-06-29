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

module.exports.updateExpense = (req, res, next) => {
  const expenseId = req.params.id;
  const userId = req.user._id;
  const { amount, date, title, recipient, category, comment } = req.body;

  Expense.findOneAndUpdate(
    { _id: expenseId, owner: userId },
    { amount, date, title, recipient, category, comment },
    { new: true, runValidators: true },
  )
    .then((expense) => {
      if (!expense) {
        return res.status(404).send({ message: 'Расход не найден' });
      }
      res.status(200).send(expense);
    })
    .catch((err) => {
      if (err.name === 'ValidationError' || err.name === 'CastError') {
        return res
          .status(400)
          .send({ message: 'Невалидные данные для обновления расхода' });
      }
      next(err);
    });
};

module.exports.deleteExpense = (req, res, next) => {
  const expenseId = req.params.id;
  const userId = req.user._id;

  Expense.findOneAndDelete({ _id: expenseId, owner: userId })
    .then((expense) => {
      if (!expense) {
        return res.status(404).send({ message: 'Расход не найден' });
      }
      res.status(200).send({ message: 'Расход успешно удалён' });
    })
    .catch((err) => {
      if (err.name === 'CastError') {
        return res.status(400).send({ message: 'Некорректный ID расхода' });
      }
      next(err);
    });
};
