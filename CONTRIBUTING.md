# Участие в разработке B5S / Contributing to B5S

## 🇷🇺 Русский

Спасибо за интерес к **B5S — Beyond the 5th Sun**! Мы рады любому вкладу: баги, баланс, код, переводы, идеи.

### Как предложить изменения

1. **Баг или идея** — заведите issue: опишите шаги воспроизведения, ожидаемое и фактическое поведение, приложите скриншоты. Для баланса — укажите сценарий (система, корабль, капитал).
2. **Код** — форкните репозиторий, сделайте ветку (`fix/...`, `feat/...`), откройте pull request. Один PR = одна логическая задача.
3. **Переводы** — словари лежат в `src/i18n/locales/`. Скопируйте `ru.ts` в `<язык>.ts`, переведите значения (ключи не трогайте) и добавьте язык в реестр `src/i18n/index.ts`.

### Правила кода

- Перед PR обязательно: `npm run check` (типы), `npm run verify` (смоук в браузере), серверные тесты `node server/test-*.mjs` — все должны быть зелёными.
- Игровой цикл не трогает React; в горячем цикле симуляции (60 Гц) — ноль аллокаций.
- Сервер остаётся без зависимостей (zero-dep Node.js); новые npm-пакеты туда не добавляем.
- Протокол клиент↔сервер меняется только через обновление `server/CONTRACT.md` в том же PR.
- Комментарии и коммиты — по-русски или по-английски, на ваш выбор.

### Координация

План работ и текущие назначения — в `PLAN.md`. Берёте задачу — отметьте в issue, чтобы не дублировать работу.

### Лицензия

Внося вклад, вы соглашаетесь с публикацией под [GNU AGPL v3](LICENSE).

---

## 🇬🇧 English

Thanks for your interest in **B5S — Beyond the 5th Sun**! Bugs, balance tweaks, code, translations and ideas are all welcome.

### How to contribute

1. **Bug or idea** — open an issue: steps to reproduce, expected vs actual behaviour, screenshots. For balance — describe the scenario (system, ship, capital).
2. **Code** — fork, branch (`fix/...`, `feat/...`), open a pull request. One PR = one logical task.
3. **Translations** — dictionaries live in `src/i18n/locales/`. Copy `ru.ts` to `<lang>.ts`, translate the values (keep the keys) and register the language in `src/i18n/index.ts`.

### Code rules

- Before a PR: `npm run check` (types), `npm run verify` (browser smoke), server tests `node server/test-*.mjs` — all must pass.
- The game loop never touches React; zero allocations in the 60 Hz hot loop.
- The server stays dependency-free (zero-dep Node.js); no new npm packages there.
- The client↔server protocol changes only together with `server/CONTRACT.md` in the same PR.
- Comments and commit messages: Russian or English, your choice.

### License

By contributing you agree to publish your work under [GNU AGPL v3](LICENSE).
