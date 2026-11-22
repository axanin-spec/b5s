# B5S — Beyond the 5th Sun

**«За пятым солнцем»** — браузерная космическая песочница в духе «Космических Рейнджеров» с живым мультиплеерным миром: шесть звёздных систем, свободный полёт, закрытая экономика, торговля, бои, контрабанда, кланы, общий серверный шард с PvP и торговлей игрок↔игрок. Играется на компьютере (клавиатура + мышь), планшете и телефоне (тач-управление).

A browser space sandbox in the spirit of Space Rangers with a living multiplayer world: six star systems, free flight, a closed economy, trading, combat, smuggling, clans — plus a shared server shard with PvP and player-to-player trade. [English below](#english).

**Игра:** https://b5s.ru

---

## Цель

Два пути к победе:
- **Экономика** — накопить долю в 25% всей денежной массы галактики (она фиксирована: 2 502 600 ₡, то есть нужно ≈625 650 ₡).
- **Война** — уничтожить три флагмана пиратских кланов и тем сломить оккупационную угрозу.

Гибель корабля — поражение; можно загрузить последний автосейв.

## Управление

| Действие | Компьютер | Тачскрин |
|---|---|---|
| Тяга двигателей | W A S D / стрелки | левая половина экрана — джойстик |
| Прицел / огонь | мышь + ЛКМ или Пробел | кнопка ОГОНЬ (автоприцел по ближайшему врагу) |
| Стыковка / гиперпрыжок | E (у станции или врат) | кнопки «Стыковка» / «Гиперпрыжок» |
| Звёздная карта | M | кнопка на HUD |
| Пауза | Esc | кнопка ⏸ |

## Мир

- **Шесть систем**: Эйдолон (торговый перекрёсток), Кронос (промышленный пояс), Никс (аграрный фронтир), Терминус (руины-хабарь, база контрабандистов), Аврора (финансовое ядро), Каркинос (крепость кланов). Полная сетка врат — 5 переходов из каждой системы; звёздная карта (M) показывает галактику и схему любой системы, клик ставит путевую точку.
- **Живой рынок**: 6 товаров, у каждого мира своя экономика (аграрный, шахтёрский, промышленный, научный, торговый хаб) и системный ценовой профиль; цены ходят случайным блужданием, события спроса публикуются в ленте новостей.
- **Закрытая экономика**: масса кредитов фиксирована и распределена по казне патруля, фонду Альянса, клановому фонду и оборотному капиталу станций. Каждый заработанный кредит выходит из чьей-то казны, каждый потраченный — возвращается. Караваны торгуют собственным капиталом, выбирают арбитражные маршруты и двигают локальные цены к равновесию; по радио можно торговать с ними прямо в космосе.
- **Оккупационный фронт**: кланы держат одну систему — патруль изгнан, работает чёрный рынок, резидентный флагман охраняет порядок. Потопление флагмана освобождает систему; через паузу кланы захватывают другую.
- **Фракции и репутация**: три оси — патруль, торговый Альянс, пиратские кланы (−100…+100). Дружественный огонь ведёт к розыску; снять его можно штрафом трибунала или искуплением головами пиратов. В статусе «свой» у кланов — свои цены, клановая доска контрактов и доступ на базу в Терминусе.
- **Контракты и события**: брокеры станций предлагают охоту, перевозки и эскорт; в оккупированных системах — клановая доска (разборки, головы патруля, тёмные рейсы). Новостная лента сообщает о рейдах на конвои — их можно перехватить за награду.
- **Налёты**: с карты галактики можно запустить операцию против свободной системы — окно на 3 минуты, эмбарго, патрульная охрана, ограбление складов станций.
- **Флот**: четыре корпуса (истребитель «Рейнджер» → корвет «Ястреб» → фрегат «Борей» → линкор «Суверен») и снаряжение трёх категорий (оружие / щиты / двигатели) линиями рангов C–SSS. Топовые ранги SS требуют дружбы с Альянсом, эксклюзив SSS — только чёрный рынок кланов.

## Мультиплеер (общий шард)

- **Аккаунты**: регистрация/логин, сейв в облаке (сервер валидирует версию и кредиты).
- **Общий мир**: общие экономические пулы (патруль/Альянс/кланы/станции), +1 000 000 ₡ в пулы за каждого зарегистрированного игрока.
- **Присутствие**: игроки видят друг друга в системе в реальном времени (WebSocket, ретрансляция 20 Гц по системам).
- **PvP**: свободный огонь по игрокам, серверная верификация попаданий (дистанция, темп, кап урона), сервер единолично объявляет смерть/респаун; розыск и штрафы — через репутацию.
- **Торговля игрок↔игрок**: эскроу-сделки на серверном ledger (атомарно, идемпотентно, переживает рестарт), дистанция ≤1500 м, TTL оффера 60 с.
- **Банк**: два кармана — локальные кредиты сейва и серверный счёт; пополнение/снятие на станциях, лимит снятия 500 000 ₡/час против абьюза.

## Техника

- Canvas 2D рендер: корабли и станции — процедурные текстуры, планеты/туманности/врата — сгенерированные ИИ спрайты из `public/assets/`; суперсэмплинг 2× и адаптивные тиры качества по FPS.
- Фиксированный шаг симуляции 60 Гц, пулы сущностей — ноль аллокаций в горячем цикле.
- Web Audio: записанные музыкальные темы для каждой системы с кроссфейдом, боевая тема по уровню угрозы, сэмплы SFX с вариациями (процедурный синтез — фолбэк), лимитер на мастер-шине.
- React-оболочка для HUD/меню/торговли; игровой цикл не трогает React.
- Сервер (`server/`): чистый Node.js без зависимостей — HTTP API, собственный WebSocket (RFC 6455, лимиты кадров и фрагментов, обязательная маскировка), JSON-персист с журналом транзакций и снапшотами. Протокол и эндпоинты: `server/CONTRACT.md`.

## Запуск

```bash
npm install
npm run dev          # разработка — http://localhost:3000
node server/index.mjs  # сервер шарда (порт 8787; PORT, DATA_DIR — через env)
npm run build        # прод-сборка в dist/ (без дебаг-мостов)
# автотесты сами пересобирают тестовый бандл с мостами __sim/__perf (pre-хук → build:test):
npm run verify       # смоук-тест сборки в браузере
npm run balance      # автотест закрытой экономики
npm run fleet        # автотест верфи и снаряжения
npm run focus        # автотест ввода и карты
npm run smuggle      # автотест клановых бортников
npm run loot         # автотест трофейных модулей
npm run watch        # автотест казны патруля и крейсера
# серверные автотесты (поднимают сервер на тестовых портах):
node server/test-world.mjs   # шард: пулы, welcome/join/state/leave, троттлинг, фильтр по системе
node server/test-pvp.mjs     # PvP: верификация хитов, kill/respawn
node server/test-ledger.mjs  # деньги: идемпотентность, лимиты, персист через рестарт
node server/test-trade.mjs   # торговля игрок↔игрок
node server/test-ws.mjs      # протокол WS: маскировка, лимиты фрагментов
VITE_API_URL=http://localhost:8788 npm run build && node server/test-e2e.mjs  # e2e: два браузера в одном шарде
```

## Лицензия

[GNU AGPL v3](LICENSE) — код открыт, включая серверную часть; производные сетевые сервисы обязаны публиковать исходники. Вклад приветствуется: см. [CONTRIBUTING.md](CONTRIBUTING.md).

---

<a id="english"></a>

# B5S — Beyond the 5th Sun (English)

A browser 2D space sandbox in the spirit of Space Rangers with a shared multiplayer shard: six star systems, free flight, a fully closed economy, inter-world trading, combat against pirates and patrols, smuggling, contracts, system occupation and fleet progression. Playable on desktop (keyboard + mouse), tablet and phone (touch).

**Play:** https://b5s.ru

## Goal

Two paths to victory:
- **Economy** — accumulate 25% of the galaxy's fixed money supply (2,502,600 ₡ total, so ≈625,650 ₡).
- **War** — destroy the three pirate clan flagships and break the occupation.

Ship destruction is defeat; you can reload the last autosave.

## World highlights

- **Six systems** with distinct economies (agricultural, mining, industrial, scientific, trade hub, clan fortress), a full jump-gate mesh and a starmap with waypoints.
- **Closed economy**: the credit supply is fixed and distributed across the patrol treasury, the Alliance fund, the clan fund and station working capital. NPC caravans trade with their own capital, pick arbitrage routes and push local prices toward equilibrium.
- **Occupation front**: clans hold one system — black market, resident flagship. Sinking it liberates the system; later the clans take another.
- **Reputation** on three axes (patrol / Alliance / clans, −100…+100): friendly fire brings a bounty; clan "insider" status unlocks clan prices, contracts and the Terminus base.
- **Fleet**: four hulls (fighter → corvette → frigate → battleship) and gear lines ranked C–SSS; SS requires Alliance friendship, SSS is black-market only.

## Multiplayer (shared shard)

- **Accounts**: register/login, cloud save (server-validated).
- **Shared world pools**: +1,000,000 ₡ injected into the economy per registered player.
- **Presence**: players see each other in the same system in real time (WebSocket relay, 20 Hz, per-system filtering).
- **PvP**: free fire at players with server-side hit verification (distance, rate, damage cap); the server authoritatively declares kills/respawns.
- **Player-to-player trade**: escrow deals on the server ledger — atomic, idempotent, restart-safe; range ≤1500 m, offer TTL 60 s.
- **Bank**: two wallets — local save credits and a server account; deposit/withdraw at stations, 500,000 ₡/hour withdrawal cap.

## Tech

- Canvas 2D renderer: procedural ship/station textures, AI-generated planet/nebula/gate sprites; 2× supersampling, adaptive quality tiers.
- Fixed 60 Hz simulation step, entity pools — zero allocations in the hot loop.
- Web Audio: recorded per-system music themes with crossfade, threat-driven combat theme, SFX samples with variations, master limiter.
- React shell for HUD/menus/trading; the game loop never touches React.
- Server (`server/`): dependency-free Node.js — HTTP API, hand-rolled WebSocket (RFC 6455 with frame/fragment limits and mandatory masking), JSON persistence with a transaction journal and snapshots. Protocol: `server/CONTRACT.md`.

## Run

```bash
npm install
npm run dev            # dev — http://localhost:3000
node server/index.mjs  # shard server (port 8787; PORT, DATA_DIR via env)
npm run build          # production build to dist/
npm run verify         # browser smoke test (auto-rebuilds test bundle)
node server/test-world.mjs  # + test-pvp / test-ledger / test-trade / test-ws
```

## License

[GNU AGPL v3](LICENSE) — the code is open, including the server; derived network services must publish their sources. Contributions welcome: see [CONTRIBUTING.md](CONTRIBUTING.md).
