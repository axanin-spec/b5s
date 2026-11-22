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
  "login.email": "Почта (для регистрации)",
  "login.signIn": "Войти",
  "login.register": "Регистрация",
  "login.forgot": "Забыли пароль?",
  "login.back": "← Назад",
  "login.code": "Код из письма",
  "login.verify": "Подтвердить",
  "login.resend": "Отправить код ещё раз",
  "login.sendCode": "Отправить код",
  "login.newPassword": "Новый пароль",
  "login.changePassword": "Сменить пароль",
  "login.resetTitle": "Сброс пароля",
  "login.msg.codeSent": "Код отправлен на почту — проверьте входящие (действует 15 минут)",
  "login.err.bad_username": "Позывной: 3–24 символа (буквы, цифры, _ и -)",
  "login.err.bad_password": "Пароль: минимум 6 символов",
  "login.err.username_taken": "Такой позывной уже занят",
  "login.err.bad_credentials": "Неверный позывной или пароль",
  "login.err.rate_limited": "Слишком много попыток — подождите минуту",
  "login.err.network": "Сервер недоступен — проверьте, что он запущен",
  "login.err.bad_email": "Укажите корректную почту",
  "login.err.email_taken": "Эта почта уже привязана к аккаунту",
  "login.err.bad_code": "Неверный код",
  "login.err.code_expired": "Код истёк — запросите новый",
  "login.err.too_many_attempts": "Слишком много попыток — запросите новый код",
  "login.err.email_not_verified": "Почта не подтверждена — введите код из письма",
  "login.err.mail_failed": "Не удалось отправить письмо — попробуйте позже",
} as const;
