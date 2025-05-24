const mongoose = require('mongoose');

const sourceUserSchema = new mongoose.Schema(
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
  {
    timestamps: true,
  },
);
sourceUserSchema.index({ name: 1, owner: 1 }, { unique: true });

module.exports = mongoose.model('SourceUser', sourceUserSchema);
