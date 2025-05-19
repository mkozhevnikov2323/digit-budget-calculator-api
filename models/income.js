const mongoose = require('mongoose');

const incomeSchema = new mongoose.Schema(
  {
    source: {
      type: String,
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    date: {
      type: Date,
      required: true,
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'user',
      required: true,
    },
    comment: {
      type: String,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model('income', incomeSchema);
