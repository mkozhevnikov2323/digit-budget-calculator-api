const Expense = require('../models/expense');

module.exports.getExpenses = async (req, res, next) => {
  try {
    const { month, year, page = 1, limit = 20 } = req.query;
    const userId = req.user._id;

    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 1);

    const filter = {
      owner: userId,
      date: { $gte: startDate, $lt: endDate },
    };

    const total = await Expense.countDocuments(filter);
    const expenses = await Expense.find(filter)
      .skip((page - 1) * limit)
      .limit(Number(limit));

    res.status(200).send({
      total,
      page: Number(page),
      limit: Number(limit),
      expenses,
    });
  } catch (err) {
    next(err);
  }
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
