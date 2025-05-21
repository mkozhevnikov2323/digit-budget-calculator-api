const mongoose = require('mongoose');
const Income = require('../models/income');
const Expense = require('../models/expense');

module.exports.getBalance = async (req, res, next) => {
  try {
    const userId = new mongoose.Types.ObjectId(String(req.user._id));

    const [totalIncome, totalExpense] = await Promise.all([
      Income.aggregate([
        { $match: { owner: userId } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Expense.aggregate([
        { $match: { owner: userId } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
    ]);

    const income = totalIncome[0]?.total || 0;
    const expense = totalExpense[0]?.total || 0;
    const balance = income - expense;

    res.status(200).send({ income, expense, balance });
  } catch (err) {
    next(err);
  }
};
