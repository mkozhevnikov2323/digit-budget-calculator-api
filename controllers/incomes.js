const Income = require('../models/income');

module.exports.getIncomes = (req, res, next) => {
  Income.find({ owner: req.user._id })
    .then((incomes) => res.status(200).send(incomes))
    .catch(next);
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
