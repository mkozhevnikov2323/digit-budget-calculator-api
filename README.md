# Budget Calculator API

![Digit Budget Calculator](https://img.shields.io/github/license/mkozhevnikov2323/digit-budget-calculator-api)
![Node Version](https://img.shields.io/badge/node-%3E=18.0.0-green)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)

RESTful API для управления личными доходами, расходами и финансовыми категориями. Предназначен для backend-части финансового приложения с авторизацией, кастомными и дефолтными категориями, гибкой аналитикой и защитой пользовательских данных.

---

## Основные возможности

- Аутентификация и авторизация JWT
- Управление доходами пользователя (CRUD)
- Управление расходами пользователя (CRUD)
- Работа с категориями и получателями расходов
  - Дефолтные и пользовательские категории
  - Связь расходов с категориями и получателями
- Источники дохода
  - Предустановленные и кастомные источники
- Аналитика баланса
  - Подсчёт баланса за период
- Логи ошибок и запросов (Winston + express-winston)
- Валидация данных (Joi + Celebrate)
- Глобальная обработка ошибок
- Поддержка CORS

---

## Технологии

- [Node.js](https://nodejs.org/)
- [Express 5](https://expressjs.com/)
- [MongoDB + Mongoose](https://mongoosejs.com/)
- [JWT](https://jwt.io/)
- [Joi](https://joi.dev/)
- [Winston](https://github.com/winstonjs/winston)
- [Nodemon](https://nodemon.io/) для разработки

---

## Требования

- Node.js >= 18
- MongoDB >= 4

---

## Быстрый старт

1. Клонируйте репозиторий:

`git clone https://github.com/mkozhevnikov2323/digit-budget-calculator-api.git`
`cd digit-budget-calculator-api`

2. Установите зависимости:

`npm install`

3. Создайте файл окружения `.env` (пример:):

`PORT=3000`
`JWT_SECRET=your_jwt_secret`
`MONGODB_URI=mongodb://localhost:27017/budget`

4. Запустите сервер (dev-режим):

`npm run dev`

---

## Структура проекта

.
├── controllers # Логика обработки роутов
├── errors # Пользовательские и глобальные ошибки
├── middlewares # Авторизация, CORS, логгер
├── models # Схемы данных Mongoose
├── routes # Маршруты API
├── server.js # Точка входа приложения
├── request.log # Файл логов запросов
├── error.log # Файл логов ошибок
└── README.md

---

## Основные эндпоинты

- `POST /auth/register` — регистрация пользователя
- `POST /auth/login` — вход пользователя
- `GET /users/me` — информация о текущем профиле
- `GET /incomes` — список доходов
- `POST /incomes` — добавить доход
- `GET /expenses` — список расходов
- `POST /expenses` — добавить расход
- `GET /balance` — расчёт баланса
- `GET /expense-categories` — список категорий расходов
- `GET /sources` — источники доходов

Полный список эндпоинтов — см. папку [`routes`](./routes)

---

## Best Practices

- Используются собственные классы ошибок (см. папку `errors`)
- Сущности разделены на дефолтные и пользовательские по разным моделям (`expenseCategoryDefault.js`, `expenseCategoryUser.js` и т.д.)
- Реализована строгая валидация входящих данных (`celebrate` + `joi`)
- Централизованный обработчик ошибок (`globalErrorHandler`)
- Все защищённые эндпоинты требуют JWT авторизации (см. `middlewares/auth.js`)
- Запросы и ошибки логируются в файлы, а не только в консоль (`express-winston`)
- Проект структурирован по feature-style (контроллеры, модели и маршруты разделены по сущностям)

---

## Рекомендации по продакшну

- Используйте сложные значения `JWT_SECRET` и храните их вне исходного кода (например, в переменных окружения или vault)
- Подключайте MongoDB из безопасных подсетей
- Настраивайте CORS (см. `middlewares/cors.js`) согласно вашим фронтам
- Логируйте ошибки в централизованный сервис (Sentry, Elastic и т.д.)
- Не забудьте убрать dev-зависимости в production-сборке

---

## Вклад и обратная связь

Пулл-реквесты и issue приветствуются! Оставляйте баги, предложения и пожелания в [issue tracker](https://github.com/mkozhevnikov2323/digit-budget-calculator-api/issues).

---

## Лицензия

ISC

---

Автор:  
_Maksim Olhovsky (mkozhevnikov23@gmail.com)_  
[GitHub](https://github.com/mkozhevnikov2323)

---
