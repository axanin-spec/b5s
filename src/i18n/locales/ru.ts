/**
 * ru.ts — русский словарь (эталон; остальные языки повторяют ключи).
 * Ключи плоские: "<область>.<сущность>[.<вариант>]".
 */

export const ru = {
  "app.title": "B5S — Beyond the 5th Sun",
  "app.tagline": "За пятым солнцем",

  "login.sub": "Общий сервер. Введите позывной и пароль.",
  "login.username": "Позывной",
  "login.password": "Пароль",
  "login.signIn": "Войти",
  "login.register": "Регистрация",
  "login.err.bad_username": "Позывной: 3–24 символа (буквы, цифры, _ и -)",
  "login.err.bad_password": "Пароль: минимум 6 символов",
  "login.err.username_taken": "Такой позывной уже занят",
  "login.err.bad_credentials": "Неверный позывной или пароль",
  "login.err.rate_limited": "Слишком много попыток — подождите минуту",
  "login.err.network": "Сервер недоступен — проверьте, что он запущен",
} as const;
