require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const { errors } = require('celebrate');

const { requestLogger, errorLogger } = require('./middlewares/logger');
const cors = require('./middlewares/cors');
const globalErrorHandler = require('./errors/globalErrorHandler');

const { PORT = 3000, NODE_ENV, DATA_BASE_URL } = process.env;
const app = express();

mongoose.connect(
  NODE_ENV === 'production'
    ? DATA_BASE_URL
    : 'mongodb://localhost:27017/budgetdb',
  {
    useNewUrlParser: true,
  },
);

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(requestLogger);
app.use(cors);

app.use(require('./routes/index'));

app.use(errorLogger);
app.use(errors());
app.use(globalErrorHandler);

app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});

// const app = express();
// app.use(express.json());

// Конфигурация соединения с базой данных
// mongoose
//   .connect('mongodb://localhost:27017/myapp', {
//     useNewUrlParser: true,
//     useUnifiedTopology: true,
//   })
//   .then(() => console.log('MongoDB connected'))
//   .catch((err) => console.error('MongoDB connection error:', err));

// // Определение схемы пользователя
// const UserSchema = new mongoose.Schema({
//   username: { type: String, required: true, unique: true },
//   password: { type: String, required: true },
// });

// const User = mongoose.model('User', UserSchema);

// // Регистрация пользователя
// app.post('/register', async (req, res) => {
//   const { username, password } = req.body;

//   // Проверка наличия данных
//   if (!username || !password) {
//     return res
//       .status(400)
//       .json({ message: 'Введите имя пользователя и пароль' });
//   }

//   try {
//     // Проверка, существует ли уже пользователь
//     const existingUser = await User.findOne({ username });
//     if (existingUser) {
//       return res.status(409).json({ message: 'Пользователь уже существует' });
//     }

//     // Хеширование пароля
//     const hashedPassword = await bcrypt.hash(password, 10);

//     // Создаем нового пользователя
//     const newUser = new User({ username, password: hashedPassword });
//     await newUser.save();

//     res.status(201).json({ message: 'Пользователь зарегистрирован' });
//   } catch (err) {
//     res.status(500).json({ message: 'Ошибка сервера' });
//   }
// });

// // Авторизация пользователя
// app.post('/login', async (req, res) => {
//   const { username, password } = req.body;

//   if (!username || !password) {
//     return res
//       .status(400)
//       .json({ message: 'Введите имя пользователя и пароль' });
//   }

//   try {
//     const user = await User.findOne({ username });
//     if (!user) {
//       return res.status(401).json({ message: 'Некорректные данные' });
//     }

//     // Проверка пароля
//     const isMatch = await bcrypt.compare(password, user.password);
//     if (!isMatch) {
//       return res.status(401).json({ message: 'Некорректные данные' });
//     }

//     // Генерация JWT
//     const token = jwt.sign(
//       { userId: user._id, username: user.username },
//       process.env.JWT_SECRET || 'mysecretkey',
//       { expiresIn: '1h' },
//     );

//     res.json({ token });
//   } catch (err) {
//     res.status(500).json({ message: 'Ошибка сервера' });
//   }
// });

// // Защищённый маршрут пример
// app.get('/profile', authenticateToken, async (req, res) => {
//   const user = await User.findById(req.user.userId).select('-password');
//   res.json(user);
// });

// // Мидлвар для проверки JWT
// function authenticateToken(req, res, next) {
//   const authHeader = req.headers['authorization'];
//   const token = authHeader && authHeader.split(' ')[1];

//   if (!token) return res.sendStatus(401);

//   jwt.verify(token, process.env.JWT_SECRET || 'mysecretkey', (err, user) => {
//     if (err) return res.sendStatus(403);
//     req.user = user;
//     next();
//   });
// }

// // Запуск сервера
// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => {
//   console.log(`Сервер запущен на порту ${PORT}`);
// });
