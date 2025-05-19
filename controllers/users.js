require('dotenv').config();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/user');

module.exports.createUser = (req, res, next) => {
  bcrypt
    .hash(req.body.password, 10)
    .then((hash) => User.create({ ...req.body, password: hash }))
    .then((user) =>
      res.status(201).send({
        email: user.email,
        _id: user._id,
      }),
    )
    .catch((err) => {
      if (err.code === 11000) {
        res.status(409).send({
          message: 'Пользователь с данным E-mail присутствует в базе.',
        });
      }
      if (err.name === 'ValidationError') {
        res.status(400).send({ message: 'Некорректные данные.' });
      }
      if (err.name === 'CastError') {
        res.status(400).send({ message: 'Некорректный id.' });
      }

      next(err);
    });
};

module.exports.login = (req, res, next) => {
  const { email, password } = req.body;

  return User.findUserByCredentials(email, password)
    .then((user) => {
      const { NODE_ENV, JWT_SECRET } = process.env;
      const token = jwt.sign(
        { _id: user._id },
        NODE_ENV === 'production' ? JWT_SECRET : 'super-secret-key',
        { expiresIn: '7d' },
      );
      res.send({ token });
    })
    .catch(next);
};

module.exports.getUserInfo = (req, res, next) => {
  User.findOne({ _id: req.user._id })
    .then((user) => res.status(200).send(user))
    .catch(next);
};

module.exports.updateUserInfo = (req, res, next) => {
  const { email } = req.body;

  User.findByIdAndUpdate(
    req.user._id,
    { email },
    {
      new: true,
    },
  )
    .then((user) => res.send(user))
    .catch((err) => {
      if (err.code === 11000) {
        res.status(409).send({
          message: 'Пользователь с данным E-mail присутствует в базе.',
        });
      }
      if (err.name === 'ValidationError') {
        res.status(400).send({ message: 'Некорректные данные.' });
      }
      if (err.name === 'CastError') {
        res.status(400).send({ message: 'Некорректный id.' });
      }

      next(err);
    });
};
