const mongoose = require('mongoose');

const expenseTitleSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
  },
  { timestamps: true },
);
expenseTitleSchema.index({ name: 1, owner: 1 }, { unique: true });

module.exports = mongoose.model('ExpenseTitle', expenseTitleSchema);
