const Expense = require('../models/expense');

module.exports.getExpenses = async (req, res, next) => {
  try {
    const {
      month,
      year,
      page,
      limit,
      noPagination,
      title,
      recipient,
      category,
      startDate,
      endDate,
    } = req.query;
    const userId = req.user._id;

    const filter = {
      owner: userId,
    };

    if (startDate && endDate) {
      filter.date = { $gte: new Date(startDate), $lte: new Date(endDate) };
    } else if (month && year) {
      const startOfMonth = new Date(year, month - 1, 1);
      const endOfMonth = new Date(year, month, 1);
      filter.date = { $gte: startOfMonth, $lt: endOfMonth };
    } else if (year) {
      const startOfYear = new Date(year, 0, 1);
      const endOfYear = new Date(year + 1, 0, 1);
      filter.date = { $gte: startOfYear, $lt: endOfYear };
    }

    if (title) {
      filter.title = { $regex: title, $options: 'i' };
    }
    if (recipient) {
      filter.recipient = { $regex: recipient, $options: 'i' };
    }
    if (category) {
      filter.category = category;
    }

    if (noPagination) {
      const expenses = await Expense.find(filter).sort({
        date: 1,
        createdAt: 1,
      });
      return res.status(200).send({
        total: expenses.length,
        page: 1,
        limit: expenses.length,
        expenses,
      });
    }

    const currentPage = parseInt(page, 10) || 1;
    const currentLimit = parseInt(limit, 10) || 20;

    const total = await Expense.countDocuments(filter);
    const expenses = await Expense.find(filter)
      .sort({ date: 1, createdAt: 1 })
      .skip((currentPage - 1) * currentLimit)
      .limit(currentLimit);

    return res.status(200).send({
      total,
      page: currentPage,
      limit: currentLimit,
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
