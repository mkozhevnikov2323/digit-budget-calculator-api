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
