const Income = require('../models/income');

module.exports.getIncomes = async (req, res, next) => {
  try {
    const {
      month,
      year,
      page,
      limit,
      noPagination,
      source,
      startDate,
      endDate,
    } = req.query;

    const userId = req.user._id;
    const filter = { owner: userId };

    if (startDate && endDate) {
      filter.date = {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      };
    } else if (month && year) {
      const startOfMonth = new Date(year, month - 1, 1);
      const endOfMonth = new Date(year, month, 1);
      filter.date = { $gte: startOfMonth, $lt: endOfMonth };
    } else if (year) {
      const startOfYear = new Date(year, 0, 1);
      const endOfYear = new Date(year + 1, 0, 1);
      filter.date = { $gte: startOfYear, $lt: endOfYear };
    }

    if (source) {
      filter.source = { $regex: source, $options: 'i' };
    }

    if (noPagination === 'true' || noPagination === true) {
      const incomes = await Income.find(filter)
        .sort({ date: 1, createdAt: 1 })
        .lean();

      return res.status(200).json({
        total: incomes.length,
        page: 1,
        limit: incomes.length,
        incomes,
      });
    }

    const currentPage = parseInt(page, 10) || 1;
    const currentLimit = parseInt(limit, 10) || 20;

    const total = await Income.countDocuments(filter);
    const incomes = await Income.find(filter)
      .sort({ date: 1, createdAt: 1 })
      .skip((currentPage - 1) * currentLimit)
      .limit(currentLimit)
      .lean();

    return res.status(200).json({
      total,
      page: currentPage,
      limit: currentLimit,
      incomes,
    });
  } catch (err) {
    next(err);
  }
};

module.exports.addIncome = (req, res, next) => {
  const { source, amount, date, comment } = req.body;

  Income.create({ source, amount, date, owner: req.user._id, comment })
    .then(() => res.status(201).send())
    .catch((err) => {
      if (err.name === 'ValidationError') {
        return res.status(400).send({ message: 'Невалидные данные дохода!' });
      }
      return next(err);
    });
};

module.exports.updateIncome = (req, res, next) => {
  const incomeId = req.params.id;
  const userId = req.user._id;

  const { source, amount, date, comment } = req.body;

  Income.findOneAndUpdate(
    { _id: incomeId, owner: userId },
    { source, amount, date, comment },
    { new: true, runValidators: true },
  )
    .then((income) => {
      if (!income) {
        return res.status(404).send({ message: 'Доход не найден' });
      }
      res.status(200).send(income);
    })
    .catch((err) => {
      if (err.name === 'ValidationError' || err.name === 'CastError') {
        return res
          .status(400)
          .send({ message: 'Невалидные данные для обновления дохода' });
      }
      next(err);
    });
};

module.exports.deleteIncome = (req, res, next) => {
  const incomeId = req.params.id;
  const userId = req.user._id;

  Income.findOneAndDelete({ _id: incomeId, owner: userId })
    .then((income) => {
      if (!income) {
        return res.status(404).send({ message: 'Доход не найден' });
      }
      res.status(200).send({ message: 'Доход успешно удалён' });
    })
    .catch((err) => {
      if (err.name === 'CastError') {
        return res.status(400).send({ message: 'Некорректный ID дохода' });
      }
      next(err);
    });
};
