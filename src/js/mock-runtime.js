/*
 * Локальная рантайм-обёртка для waste-paper.html.
 *
 * Подменяет все запросы к серверу на данные из переменных (объект `db`),
 * а WebSocket общей доски — на фейковый сокет, чтобы страница открывалась
 * и работала локально, без бэкенда.
 *
 * Все настройки мок-данных — в объекте DEFAULTS ниже. По умолчанию всё
 * «нулевое», как на старте ивента: 0 мелков, заданий нет, тетрадь пустая,
 * доска почёта пустая. Чтобы наполнить любой экран — поменяй значение в
 * DEFAULTS (список вариантов — в комментариях рядом с полем): задания
 * собирает buildTasks(), историю — buildHistory(), топ — buildHonor().
 */
(() => {
    "use strict";

    // ─── Конфиг (переживает перезагрузку) ────────────────────────────────

    const CFG_KEY = "__mock_cfg_v1";

    // ─── Настройки мок-данных ────────────────────────────────────────────
    //
    // Здесь можно менять состояние любого экрана. Значения ниже — то, что
    // подставляется при загрузке страницы; список вариантов указан в
    // комментариях у каждого поля.

    const DEFAULTS = {
        boot: "ready",          // ready | failed — успешный старт или ошибка входа
        canClose: false,        // показывать кнопку «закрыть» (нативная оболочка)
        latency: 250,           // задержка ответа мок-сервера, мс
        failOnce: false,
        fail: {},               // endpoint -> режим ошибки (ключи из ENDPOINTS)

        balance: 0,             // мелков на балансе при заходе (поставь любое число)

        // ─── Задания ─────────────────────────────────────────────────────
        // "empty" — заданий на сегодня нет (по умолчанию), список пустой.
        // Чтобы наполнить, поставь:
        //   "fresh"      — все задания не выполнены;
        //   "mixed"      — всё вперемешку: сделано / на проверке / не зачтено и т.д.;
        //   "allDone"    — все задания выполнены;
        //   "allSettled" — часть выполнена, часть исчерпала попытки.
        // Сами задания лежат в TASK_BASE, а состояния — в TASK_PRESETS ниже.
        tasks: "empty",
        verdict: "passed",      // passed | rejected | failed | never — итог проверки отправленного задания
        verdictDelay: 4,        // через сколько секунд проверка завершится

        // Через сколько секунд придут новые задания. 0 — отсчёт не идёт,
        // на экране заданий будет «новые задания через 0 ч 0 мин».
        // Поставь, например, 5 * 3600 (5 часов) или 90 * 60 — и появится
        // живой обратный отсчёт.
        cycleIn: 0,

        // Записи в «Уже сделано» (тетрадь): "empty" — пусто (по умолчанию);
        // "some" | "many" — заполненная история. Собирает buildHistory().
        history: "empty",

        // ─── Доска почёта ────────────────────────────────────────────────
        // "empty" — топ пустой (по умолчанию).
        // Чтобы заполнить, поставь любое из:
        //   "top1"  — я на 1 месте;   "top3" — я в топ-3;
        //   "mid"   — я в середине;   "out"  — я вне топ-100.
        // Список участников собирает функция buildHonor() ниже.
        honor: "empty",

        // ─── Магазин ─────────────────────────────────────────────────────
        shopMode: "timer",      // timer | all — витрина по таймеру или всё сразу
        shopRefresh: 3 * 3600,  // через сколько секунд смена витрины
        shopPreset: "default",  // default | limited
        purchased: "some",      // some | empty — мои покупки
        profile: "full",        // full | empty — чужой профиль

        // ─── Общая доска ─────────────────────────────────────────────────
        // "empty" — доска пустая (по умолчанию); "some" | "busy" — с рисунками.
        board: "empty",
        chalk: 2,               // мелков в инвентаре
        cloth: 1,               // тряпок в инвентаре
        socket: "live",         // live | down — состояние WebSocket
        online: 0,              // сколько человечков «онлайн» (0 — у доски никого)

        // ─── Фото на аватарку ────────────────────────────────────────────
        avatar: "ready",        // ready | arrives | waiting | used | active | pending | paused

        // ─── Макулатура ──────────────────────────────────────────────────
        // "zero" — ничего не собрано (по умолчанию): 0 из 0 постов.
        // "partial" | "almost" — сбор идёт; "done" — цель выполнена, сбор закрыт.
        waste: "zero",
        wasteMine: 0,           // сколько сдал я (рюкзак)

        // Общая цель сбора — сколько всего постов нужно собрать.
        // 0 — цель не задана, на экране «Собрано 0 из 0» и 0%.
        // Поставь, например, 10000 — и появится «Собрано 0 из 10000».
        wasteTarget: 0,
    };

    const readJSON = key => {
        try {
            return JSON.parse(localStorage.getItem(key) || "null");
        } catch {
            return null;
        }
    };
    const writeJSON = (key, value) => {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch {}
    };

    const stored = readJSON(CFG_KEY) || {};
    const cfg = { ...structuredClone(DEFAULTS), ...stored, fail: { ...(stored.fail || {}) } };
    const saveCfg = () => writeJSON(CFG_KEY, cfg);

    // ─── Общие утилиты ───────────────────────────────────────────────────

    const ME = "dev-user";
    const OTHER = "other-profile";
    const b64url = s => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const TOKEN = `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify({ sub: ME }))}.dev`;

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const clone = v => (v === undefined ? v : structuredClone(v));
    const uid = () => globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const pick = arr => arr[Math.floor(Math.random() * arr.length)];
    const iso = msAgo => new Date(Date.now() - msAgo).toISOString();
    const HOUR = 3600e3;
    const DAY = 24 * HOUR;

    const svgUri = svg => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const initialsAvatar = (text, bg) =>
        svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${bg}"/><text x="32" y="41" font-family="sans-serif" font-size="26" font-weight="700" fill="#fff" text-anchor="middle">${text}</text></svg>`);

    const ECO_PIN = svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><circle cx="100" cy="100" r="92" fill="#2f7d4f" stroke="#e8f5e0" stroke-width="8"/><path d="M60 120c0-40 35-65 85-68-5 48-30 82-70 82-6 0-11-1-15-3" fill="#8ee08f"/><path d="M62 140c20-30 40-48 70-66" stroke="#1d4d31" stroke-width="6" fill="none" stroke-linecap="round"/><text x="100" y="178" font-family="sans-serif" font-size="20" font-weight="700" fill="#e8f5e0" text-anchor="middle">ЭКО</text></svg>`);
    const PENDING_AVATAR = svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffb86b"/><stop offset="1" stop-color="#ff5d8f"/></linearGradient></defs><rect width="512" height="512" fill="url(#g)"/><circle cx="256" cy="210" r="90" fill="#fff5"/><rect x="120" y="320" width="272" height="150" rx="75" fill="#fff5"/><text x="256" y="450" font-family="sans-serif" font-size="30" fill="#fff" text-anchor="middle">Создаётся…</text></svg>`);

    // ─── Лог мок-сервера (в консоль браузера) ────────────────────────────

    const log = (text, kind = "info") => console.debug(kind === "info" ? `[mock] ${text}` : `[mock:${kind}] ${text}`);

    // ─── Коды ошибок ─────────────────────────────────────────────────────

    const ERRORS = {
        hang: { label: "⏳ бесконечная загрузка" },
        network: { status: 0, label: "нет сети (status 0)" },
        http500: { status: 500, label: "500 сервер упал" },
        http401: { status: 401, label: "401 вход устарел" },
        http404: { status: 404, label: "404 не найдено" },
        RATE_LIMIT_EXCEEDED: { status: 429 },
        IDEMPOTENCY_CONFLICT: { status: 409 },
        EVENT_PURCHASES_DISABLED: { status: 503 },
        EVENT_APPLICATIONS_DISABLED: { status: 503 },
        DELIVERY_DISABLED: { status: 503 },
        INSUFFICIENT_CHALKS: { status: 409 },
        AURA_ALREADY_MEASURED: { status: 409 },
        ALREADY_PURCHASED: { status: 409 },
        NICKNAME_ALREADY_DRAWN: { status: 409 },
        NOT_ON_SHOWCASE: { status: 409 },
        ITEM_NOT_AVAILABLE: { status: 409 },
        INVALID_VARIANT: { status: 400 },
        OWN_PROFILE: { status: 400 },
        CURTAINS_FUNDED: { status: 409 },
        NO_CURTAINS: { status: 409 },
        NOT_OWNED: { status: 409 },
        TARGET_VALIDATION_UNAVAILABLE: { status: 503 },
        PROFILE_TARGET_NOT_FOUND: { status: 404 },
        ATTEMPT_ALREADY_USED: { status: 409 },
        AVATAR_MODERATION_REJECTED: { status: 422 },
        AVATAR_MODERATION_UNAVAILABLE: { status: 503 },
        NO_PROFILE_AVATARS: { status: 409 },
        PROFILE_AVATAR_PAUSED: { status: 409 },
        PROFILE_AVATAR_PURCHASE_REQUIRED: { status: 409 },
        BOARD_DRAWING_OVERLAP: { status: 409 },
        BOARD_WIPE_LIMIT_EXCEEDED: { status: 422 },
        INVALID_BOARD_WIPE: { status: 400 },
        NO_WASTE_PAPER: { status: 409 },
    };

    const ENDPOINTS = {
        load: "GET /tasks",
        submit: "POST /tasks/:code/submission",
        submissionStatus: "GET /tasks/:code/submission",
        completedTasks: "GET /tasks/completed",
        balance: "GET /balance",
        honorBoard: "GET /honor-board",
        shop: "GET /shop",
        buy: "POST покупка (/shop, /aura, /nicknames, /sounds)",
        purchased: "GET /shop/purchased",
        myProfile: "GET /profiles/:id + /nicknames",
        setNickname: "PUT /nicknames/active",
        setCurtains: "PUT /profiles/:id/curtains",
        avatar: "GET /api/profile-avatar/",
        uploadAvatar: "POST /api/files/avatar",
        deleteFile: "DELETE /api/files/:id",
        installAvatar: "PUT /api/profile-avatar/",
        board: "GET /board",
        boardShop: "GET /shop/board",
        boardInventory: "GET /board/inventory",
        boardTicket: "POST /board/socket-ticket",
        publishDrawing: "POST /board/drawings",
        wipeBoard: "POST /board/wipes",
        wastePaper: "GET /waste-paper",
        handInWastePaper: "POST /waste-paper/hand-ins",
    };

    // ─── Данные: задания ─────────────────────────────────────────────────

    const TODAY_CYCLE = new Date().toISOString().slice(0, 10);
    const ALICE_URL = "https://alice.yandex.ru/";

    const TASK_BASE = [
        {
            code: "algebra-zero",
            subject: "Алгебра",
            title: "Деление на ноль",
            description: "Попроси Алису AI объяснить, почему на ноль делить нельзя, и приведи свой пример из жизни",
            reward: 10,
            difficulty: "easy",
            minutes: "5 минут",
            save: "ссылку на разговор, где есть твой пример",
        },
        {
            code: "lit-onegin",
            subject: "Литература",
            title: "Онегин в соцсетях",
            description: "Придумай вместе с Алисой AI, какой пост Евгений Онегин выложил бы после дуэли",
            reward: 15,
            difficulty: "medium",
            minutes: "10 минут",
            save: "разговор с готовым постом",
        },
        {
            code: "bio-cell",
            subject: "Биология",
            title: "Клетка как город",
            description: "Разбери с Алисой AI, на какие части города похожи органоиды клетки: кто электростанция, кто почта",
            reward: 25,
            difficulty: "hard",
            minutes: "15 минут",
            save: "ссылку на разговор со сравнением",
        },
        {
            code: "history-date",
            subject: "История",
            title: "Одна дата",
            description: "Выбери любую дату из учебника и узнай у Алисы AI, что в этот день происходило в других странах",
            reward: 15,
            difficulty: "medium",
            minutes: "10 минут",
            save: "",
        },
        {
            code: "english-slang",
            subject: "Английский",
            title: "School slang",
            description: "Спроси Алису AI про пять школьных словечек на английском и составь с ними диалог",
            reward: 10,
            difficulty: "easy",
            minutes: "",
            save: "разговор с диалогом",
        },
        {
            code: "geo-map",
            subject: "География",
            title: "Карта двора",
            description: "Опиши Алисе AI свой двор и попроси превратить его в карту с условными обозначениями",
            reward: 20,
            difficulty: "hard",
            minutes: "20 минут",
            save: "ссылку на разговор с картой",
        },
    ];

    const sub = (status, extra = {}) => {
        const attemptsUsed = extra.attemptsUsed ?? 1;
        return {
            status,
            attemptsUsed,
            attemptsLeft: 3 - attemptsUsed,
            maxAttempts: 3,
            reason: null,
            queuePosition: null,
            ...extra,
        };
    };

    // Доигрывать ли проверку у заданий, которые «висят в очереди» из пресета
    // (то есть не отправлены пользователем). false — мелки сами по себе не
    // начисляются; поставь true, если хочешь, чтобы такое задание через
    // verdictDelay секунд само становилось «засчитано».
    const AUTO_VERDICT_PRESET_TASKS = false;

    const TASK_PRESETS = {
        fresh: () => TASK_BASE.map(() => ({ completedAt: null, submission: null })),
        mixed: () => [
            { completedAt: iso(2 * HOUR), submission: sub("passed") },
            // второе задание «на проверке»: так и останется в этом состоянии,
            // мелки (+15) сами не начислятся — см. AUTO_VERDICT_PRESET_TASKS
            { completedAt: null, submission: sub("queued", { queuePosition: 3 }) },
            { completedAt: null, submission: sub("rejected", { attemptsUsed: 1, reason: "В разговоре нет сравнения с городом." }) },
            { completedAt: null, submission: sub("rejected", { attemptsUsed: 3, reason: "Дата не из учебника истории." }) },
            { completedAt: null, submission: sub("failed", { attemptsUsed: 0, reason: "Не получилось открыть разговор по ссылке." }) },
            { completedAt: null, submission: null },
        ],
        allDone: () => TASK_BASE.map((_, i) => ({ completedAt: iso((i + 1) * 20 * 60e3), submission: sub("passed") })),
        allSettled: () => TASK_BASE.map((_, i) =>
            i % 2
                ? { completedAt: null, submission: sub("rejected", { attemptsUsed: 3, reason: "Задание выполнено не полностью." }) }
                : { completedAt: iso((i + 1) * 20 * 60e3), submission: sub("passed") }),
        empty: () => [],
    };

    function buildTasks(preset, cycle) {
        const states = (TASK_PRESETS[preset] ?? TASK_PRESETS.mixed)();
        return states.map((state, i) => ({
            ...TASK_BASE[i],
            code: cycle === TODAY_CYCLE ? TASK_BASE[i].code : `${TASK_BASE[i].code}-${cycle}`,
            cycle,
            aliceUrl: ALICE_URL,
            ...state,
        }));
    }

    const HISTORY_SUBJECTS = ["Алгебра", "Физика", "Литература", "Химия", "История", "Английский", "Информатика", "Биология", "География", "Обществознание", "Музыка", "ИЗО"];

    function buildHistory(preset) {
        const count = preset === "many" ? 37 : preset === "some" ? 7 : 0;
        return Array.from({ length: count }, (_, i) => ({
            code: `old-${i}`,
            cycle: new Date(Date.now() - (Math.floor(i / 3) + 1) * DAY).toISOString().slice(0, 10),
            title: HISTORY_SUBJECTS[i % HISTORY_SUBJECTS.length],
            subject: HISTORY_SUBJECTS[i % HISTORY_SUBJECTS.length],
            reward: [10, 15, 20, 25][i % 4],
            completedAt: iso((Math.floor(i / 3) + 1) * DAY + (i % 3) * HOUR),
        }));
    }

    // ─── Данные: доска почёта ────────────────────────────────────────────

    const FIRST = ["Аня", "Миша", "Соня", "Тимур", "Лиза", "Глеб", "Вера", "Артём", "Даша", "Рома", "Ева", "Марк", "Полина", "Егор", "Ксюша", "Лёва"];
    const LAST = ["Котова", "Орлов", "Белова", "Зайцев", "Смирнова", "Громов", "Лебедева", "Павлов"];
    const EMOJI = ["🦊", "🐸", "🦉", "🐙", "🐼", "🦄", "🐝", "🐧", "🦖", "🐳"];
    const COLORS = ["#e76f51", "#2a9d8f", "#8d6cff", "#f4a261", "#3a86ff", "#ef476f"];
    const ME_AUTHOR = { displayName: "Тест Тестович", username: "test_user", avatar: "🧪" };

    function person(i) {
        const first = FIRST[i % FIRST.length];
        const last = LAST[(i * 7) % LAST.length];
        const username = `${["chechik", "school", "pupil", "alice_fan"][i % 4]}${i + 1}`;
        const author = { displayName: i % 9 === 5 ? "" : `${first} ${last}`, username };
        if (i % 3 === 0) author.avatarImageUrl = initialsAvatar(first[0], COLORS[i % COLORS.length]);
        else if (i % 3 === 1) author.avatar = EMOJI[i % EMOJI.length];
        return author;
    }

    // Сколько строк в заполненном топе. Можно поставить любое число.
    const HONOR_ROWS = 100;

    // Собирает таблицу лидеров для доски почёта.
    //
    //   preset — состояние топа (значение cfg.honor):
    //       "empty" — пустой топ (по умолчанию);
    //       "top1" | "top3" | "mid" | "out" — заполненный топ,
    //       где я стою на 1-м / 3-м / 17-м месте или вне топ-100.
    //   count — сколько строк рисовать (по умолчанию HONOR_ROWS).
    //
    // Участников генерирует person(i) из списков FIRST / LAST / EMOJI
    // выше. Чтобы заполнить топ своими данными — просто верни готовый
    // массив вида [{ rank, earned, userId, author }, …] вместо этого кода.
    function buildHonor(preset, count = HONOR_ROWS) {
        if (preset === "empty") return [];
        const rows = Array.from({ length: count }, (_, i) => ({ userId: `user-${i}`, author: person(i) }));
        const MY_RANK = { top1: 1, top3: 3, mid: 17, out: null };
        const myRank = preset in MY_RANK ? MY_RANK[preset] : 17;   // "out" = null → меня нет в списке
        if (myRank !== null && myRank <= count) rows.splice(myRank - 1, 1, { userId: ME, author: ME_AUTHOR });
        let earned = 1480;
        return rows.map((row, i) => {
            earned -= i === 0 ? 0 : 3 + ((i * 13) % 11);
            return { rank: i + 1, earned: Math.max(5, earned), ...row };
        });
    }

    // ─── Данные: магазин ─────────────────────────────────────────────────

    const SHOP_ITEMS = [
        { id: "school_stickers", title: "Наклейки", subtitle: "Прилепи на чужой профиль", price: 15, audience: "other", perUser: null,
            details: "Набор школьных наклеек. Одну можно прилепить на профиль одноклассника — все увидят.",
            bullets: ["отправляется в рюкзак", "висит на профиле сутки"] },
        { id: "water_balloons", title: "Шарик с водой", subtitle: "Кинь в чужой профиль", price: 20, audience: "other", perUser: null,
            details: "Мокрое пятно на аватарке у того, в кого попадёшь.", bullets: ["отправляется в рюкзак"] },
        { id: "break_window", title: "Портфель", subtitle: "Разбей окно в чужом профиле", price: 40, audience: "other", perUser: null,
            details: "Тяжёлый портфель. Окно в профиле разобьётся, пока хозяин не починит.", bullets: ["отправляется в рюкзак", "окно чинится само через 12 часов"] },
        { id: "whoopee_cushion", title: "Подушка-пердушка", subtitle: "Подложи на чужой профиль", price: 25, audience: "other", perUser: null,
            details: "Классика школьных розыгрышей.", bullets: ["отправляется в рюкзак"] },
        { id: "red_pen", title: "Красная ручка", subtitle: "Поставь оценку посту", price: 30, audience: "other", perUser: null,
            details: "Поставь двойку или пятёрку чужому посту красной ручкой.", bullets: [] },
        { id: "eraser", title: "Ластик", subtitle: "Сотри наклейку со своего профиля", price: 10, audience: "self", perUser: null,
            details: "Стирает одну наклейку или пятно.", bullets: ["отправляется в рюкзак"] },
        { id: "duty_corrector", title: "Корректор дежурного", subtitle: "Замажь, что не нравится", price: 35, audience: "self", perUser: 2,
            details: "Корректор, который дежурный забыл на парте.", bullets: ["не больше двух в одни руки"] },
        { id: "aura_analyzer", title: "Измеритель ауры", subtitle: "Узнай свою ауру", price: 30, audience: "self", perUser: 1,
            details: "Прибор покажет, сколько у тебя ауры — от 0 до 100.", bullets: ["один раз на ивент", "результат виден в профиле"] },
        { id: "random_nickname", title: "Случайная кликуха", subtitle: "Школьное прозвище в профиль", price: 25, audience: "self", perUser: null,
            details: "Выпадает случайная кликуха. Любую из выпавших можно показывать в профиле.", bullets: ["может выпасть повтор"] },
        { id: "school_bell", title: "Школьный звонок", subtitle: "Прозвени для всех онлайн", price: 50, audience: "any", perUser: null,
            details: "Все, кто сейчас в ивенте, услышат звонок.", bullets: ["срабатывает сразу"] },
        { id: "post_notebook", title: "Тетрадка для постов", subtitle: "Фон постов как в тетради", price: 45, audience: "self", perUser: 1,
            details: "Посты будут выглядеть как страница тетради.", bullets: ["появится в соцсети"],
            variants: [{ id: "ruled", title: "в линейку" }, { id: "grid", title: "в клетку" }] },
        { id: "profile_avatar", title: "Фото на аватарку", subtitle: "Поставь свою картинку", price: 60, audience: "self", perUser: null,
            details: "После покупки выберешь картинку и поставишь её на аватарку.", bullets: ["картинка проходит проверку"] },
        { id: "pin_alice_ai", title: "Пин «Алиса AI»", subtitle: "Значок на профиль", price: 80, audience: "self", perUser: 1,
            details: "Коллекционный пин ивента.", bullets: ["появится в соцсети"] },
        { id: "pin_note", title: "Пин «Записка»", subtitle: "Значок на профиль", price: 70, audience: "self", perUser: 1,
            details: "Пин в виде сложенной записки.", bullets: ["появится в соцсети"] },
        { id: "curtains_fund", title: "Фонд штор", subtitle: "Скинься на шторы", price: 10, audience: "self", perUser: null,
            details: "", bullets: [] },
        { id: "board_drawing", title: "Мел для доски", subtitle: "Один рисунок на общей доске", price: 15, audience: "any", perUser: null,
            details: "", bullets: [] },
        { id: "board_cloth", title: "Тряпка для доски", subtitle: "Один проход по доске", price: 10, audience: "any", perUser: null,
            details: "", bullets: [] },
    ];
    const BACKPACK = new Set(["school_stickers", "water_balloons", "break_window", "whoopee_cushion", "eraser"]);
    const DELIVERED = new Set(["post_notebook", "pin_alice_ai", "pin_note", "red_pen", "duty_corrector"]);
    const NICKNAMES = ["БОТАН", "КРАШ", "СИГМА", "СУЕТОЛОГ", "ПРОФЕССОР", "МАЛОЙ", "БАТОН", "ЦИРКУЛЬ"];

    function buildShop(preset) {
        return SHOP_ITEMS.map(item => {
            const row = { ...clone(item), isAvailable: true, purchased: 0, owned: 0 };
            if (preset === "limited") {
                if (item.id === "aura_analyzer" || item.id === "pin_note") row.purchased = row.perUser;
                if (item.id === "school_bell" || item.id === "red_pen") row.isAvailable = false;
                if (item.id === "school_stickers") { row.purchased = 3; row.owned = 2; }
                if (item.id === "eraser") { row.purchased = 1; row.owned = 1; }
            }
            return row;
        });
    }

    function buildPurchased(preset) {
        if (preset === "empty") return [];
        return [
            { id: "school_stickers", title: "Наклейки", total: 4, available: 2, pending: 0, used: 2 },
            { id: "aura_analyzer", title: "Измеритель ауры", total: 1, available: 0, pending: 0, used: 1 },
            { id: "post_notebook", title: "Тетрадка для постов", total: 1, available: 0, pending: 1, used: 0 },
            { id: "nick_krash", title: "КРАШ", total: 1, available: 1, pending: 0, used: 0 },
        ];
    }

    function buildProfile(preset) {
        if (preset === "empty") {
            return { aura: null, active: null, owned: [], curtains: { goal: 500, fund: 120, hasCurtains: false, closed: false } };
        }
        return { aura: 73, active: "КРАШ", owned: ["БОТАН", "КРАШ", "ЦИРКУЛЬ"], curtains: { goal: 500, fund: 500, hasCurtains: true, closed: false } };
    }

    // ─── Данные: общая доска ─────────────────────────────────────────────

    const CONTRACT = {
        width: 1024,
        height: 1024,
        lineBudget: 1140,
        minStrokeLength: 2,
        maxDrawingWidth: 213,
        maxDrawingHeight: 160,
        maxStrokes: 48,
        maxPoints: 1400,
        wipeRadius: 42,
        maxWipePoints: 192,
        maxWipeLength: 480,
        maxWipeSpan: 360,
        colors: ["#f5f1df", "#ff748c", "#73d6ff", "#7ee38a"],
        widths: [6],
    };

    const round = p => ({ x: Math.round(p.x), y: Math.round(p.y) });
    const ring = (cx, cy, rx, ry, n = 28, from = 0, to = Math.PI * 2) =>
        Array.from({ length: n + 1 }, (_, i) => {
            const a = from + (to - from) * (i / n);
            return round({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
        });

    const SHAPES = {
        smile: (x, y) => [ring(x, y, 60, 60), ring(x, y + 8, 34, 24, 12, 0.2, Math.PI - 0.2), ring(x - 20, y - 18, 5, 5, 8), ring(x + 20, y - 18, 5, 5, 8)],
        star: (x, y) => [Array.from({ length: 11 }, (_, i) => {
            const r = i % 2 ? 26 : 64;
            const a = -Math.PI / 2 + (i * Math.PI) / 5;
            return round({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r });
        })],
        heart: (x, y) => [Array.from({ length: 41 }, (_, i) => {
            const t = (i / 40) * Math.PI * 2;
            return round({ x: x + 3.6 * 16 * Math.sin(t) ** 3, y: y - 3.4 * (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) });
        })],
        wave: (x, y) => [Array.from({ length: 30 }, (_, i) => round({ x: x - 95 + i * 6.5, y: y + Math.sin(i / 2.5) * 22 }))],
        house: (x, y) => [
            [{ x: x - 60, y: y + 60 }, { x: x - 60, y: y - 10 }, { x: x + 60, y: y - 10 }, { x: x + 60, y: y + 60 }, { x: x - 60, y: y + 60 }].map(round),
            [{ x: x - 75, y: y - 5 }, { x, y: y - 70 }, { x: x + 75, y: y - 5 }].map(round),
            [{ x: x - 15, y: y + 60 }, { x: x - 15, y: y + 20 }, { x: x + 15, y: y + 20 }, { x: x + 15, y: y + 60 }].map(round),
        ],
        five: (x, y) => [
            [{ x: x + 40, y: y - 60 }, { x: x - 30, y: y - 60 }, { x: x - 36, y: y - 5 }].map(round),
            ring(x, y + 22, 42, 38, 20, -Math.PI * 0.85, Math.PI * 0.75),
        ],
    };

    function makeDrawing(shape, x, y, color, author, id = uid()) {
        const strokes = SHAPES[shape](x, y).map(points => ({ color, width: 6, points }));
        return { id, strokes, bounds: boundsOf(strokes), author, authorVisible: true, createdAt: new Date().toISOString() };
    }

    function boundsOf(strokes) {
        let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
        for (const s of strokes) {
            for (const p of s.points) {
                left = Math.min(left, p.x);
                right = Math.max(right, p.x);
                top = Math.min(top, p.y);
                bottom = Math.max(bottom, p.y);
            }
        }
        return { left, top, right, bottom };
    }

    const boardAuthor = i => {
        const a = person(i + 3);
        return { id: `user-${i + 3}`, username: a.username, displayName: a.displayName || a.username };
    };

    function buildBoard(preset) {
        const shapes = Object.keys(SHAPES);
        let spots = [];
        if (preset === "some") spots = [[180, 200], [520, 160], [840, 260], [300, 560], [760, 640], [520, 860]];
        if (preset === "busy") {
            for (let r = 0; r < 4; r += 1) for (let c = 0; c < 4; c += 1) spots.push([130 + c * 250, 130 + r * 250]);
        }
        const drawings = spots.map(([x, y], i) =>
            makeDrawing(shapes[i % shapes.length], x, y, CONTRACT.colors[i % CONTRACT.colors.length], boardAuthor(i)));
        const wipes = preset === "empty" ? [] : [{
            id: uid(),
            smudges: [{ color: "#f5f1df", points: ring(700, 420, 80, 30, 14), strength: 1 }],
        }];
        return { revision: drawings.length + wipes.length + 1, drawings, wipes };
    }

    function buildInventory(chalk, cloth) {
        return [
            ...Array.from({ length: chalk }, () => ({ id: uid(), kind: "board_drawing" })),
            ...Array.from({ length: cloth }, () => ({ id: uid(), kind: "board_cloth" })),
        ];
    }

    // ─── Данные: аватарка и макулатура ───────────────────────────────────

    function buildAvatar(preset) {
        const active = { revision: "file-active", url: initialsAvatar("D", "#3a86ff") };
        const base = { eventId: "aliceai", balance: 1, active: null, pending: null, applicationsEnabled: true };
        switch (preset) {
            case "arrives":
            case "waiting": return { ...base, balance: 0 };
            case "used": return { ...base, balance: 0, active };
            case "active": return { ...base, active };
            case "pending": return { ...base, pending: { fileId: "file-pending", url: PENDING_AVATAR } };
            case "paused": return { ...base, applicationsEnabled: false };
            default: return base;
        }
    }

    const WASTE_TOTALS = { zero: 0, partial: 4321, almost: 9990, done: 10240 };

    // ─── База мок-сервера ────────────────────────────────────────────────

    const bootAt = Date.now();
    const db = {
        balance: cfg.balance,
        cycle: TODAY_CYCLE,
        cycleStartsAt: new Date(Date.now() - 6 * HOUR).toISOString(),
        cycleEndsAt: Date.now() + cfg.cycleIn * 1e3,
        tasks: buildTasks(cfg.tasks, TODAY_CYCLE),
        subsStartedAt: new Map(),
        history: buildHistory(cfg.history),
        honor: buildHonor(cfg.honor),            // пусто по умолчанию, см. cfg.honor
        shop: buildShop(cfg.shopPreset),
        shopEndsAt: Date.now() + cfg.shopRefresh * 1e3,
        purchased: buildPurchased(cfg.purchased),
        profile: buildProfile(cfg.profile),
        board: buildBoard(cfg.board),
        inventory: buildInventory(cfg.chalk, cfg.cloth),
        avatar: buildAvatar(cfg.avatar),
        waste: { total: WASTE_TOTALS[cfg.waste] ?? 0, mine: cfg.wasteMine, handedIn: cfg.waste === "zero" ? 0 : 37, closed: cfg.waste === "done" },
        buyResults: new Map(),
    };

    // ─── Мок-API (тот же интерфейс, что у r3() в бандле) ─────────────────

    function makeApi(P) {
        const fail = (status, code, message = "Произошла ошибка") => new P(status, code, message);

        function modeError(mode) {
            if (mode === "network") return fail(0, "network", "Сервер не ответил");
            const spec = ERRORS[mode];
            if (!spec) return fail(500, "500", "Неизвестный режим");
            return mode.startsWith("http") ? fail(spec.status, String(spec.status), "Запрос не прошёл") : fail(spec.status, mode, `Ошибка: ${mode}`);
        }

        async function call(name, args, fn) {
            await sleep(cfg.latency);
            const mode = cfg.fail[name];
            if (mode) {
                if (cfg.failOnce) {
                    delete cfg.fail[name];
                    saveCfg();
                }
                if (mode === "hang") {
                    log(`${ENDPOINTS[name]} ⏳ висит`, "warn");
                    return new Promise(() => {});
                }
                const err = modeError(mode);
                log(`${ENDPOINTS[name]} → ${err.status} ${err.code}`, "err");
                throw err;
            }
            try {
                const result = await fn(...args);
                log(`${ENDPOINTS[name]} → ok`);
                return clone(result);
            } catch (err) {
                log(`${ENDPOINTS[name]} → ${err.status} ${err.code}`, "err");
                throw err;
            }
        }

        const wrap = (name, fn) => (...args) => call(name, args, fn);

        // Задания: проверка идёт по таймеру, результат — из cfg.verdict.
        //
        // Мелки сами по себе не прибавляются: проверку проходят только те
        // задания, которые отправил пользователь (в submit пишется
        // subsStartedAt). Предзаполненные из пресета остаются ровно в том
        // состоянии, как заданы в TASK_PRESETS, — поэтому «+15» не всплывает
        // и баланс не растёт без действий. См. AUTO_VERDICT_PRESET_TASKS.
        function progress(task) {
            const s = task.submission;
            if (!s || (s.status !== "queued" && s.status !== "running")) return;
            if (!AUTO_VERDICT_PRESET_TASKS && !db.subsStartedAt.has(task.code)) return;
            const started = db.subsStartedAt.get(task.code) ?? bootAt;
            const elapsed = (Date.now() - started) / 1e3;
            if (s.status === "queued" && elapsed > 1.5) {
                task.submission = { ...s, status: "running", queuePosition: null };
            }
            if (cfg.verdict === "never" || elapsed < cfg.verdictDelay) return;
            const cur = task.submission;
            if (cfg.verdict === "passed") {
                task.submission = { ...cur, status: "passed", reason: null };
                task.completedAt = new Date().toISOString();
                db.balance += task.reward;
                db.history.unshift({ code: task.code, cycle: task.cycle, title: task.title, subject: task.subject, reward: task.reward, completedAt: task.completedAt });
                bumpHonor(task.reward);
            } else if (cfg.verdict === "rejected") {
                task.submission = { ...cur, status: "rejected", reason: "В разговоре нет ответа на вопрос задания." };
            } else {
                // failed — попытка не тратится
                const attemptsUsed = Math.max(0, cur.attemptsUsed - 1);
                task.submission = { ...cur, status: "failed", attemptsUsed, attemptsLeft: 3 - attemptsUsed, reason: "Не получилось открыть разговор по ссылке." };
            }
            db.subsStartedAt.delete(task.code);
        }

        function bumpHonor(reward) {
            const me = db.honor.find(e => e.userId === ME);
            if (!me) return;
            me.earned += reward;
            db.honor.sort((a, b) => b.earned - a.earned);
            db.honor.forEach((e, i) => { e.rank = i + 1; });
        }

        function rollCycle() {
            if (cfg.cycleIn <= 0) return;                  // отсчёт выключен — цикл не меняем
            if (Date.now() < db.cycleEndsAt) return;
            const next = new Date(Date.now() + DAY).toISOString().slice(0, 10);
            db.cycle = next;
            db.cycleStartsAt = new Date().toISOString();
            db.cycleEndsAt = Date.now() + DAY;
            // Новый цикл: если задания выключены (cfg.tasks = "empty"), список
            // так и остаётся пустым и после смены цикла.
            db.tasks = cfg.tasks === "empty" ? [] : buildTasks("fresh", next);
            log("Новый цикл заданий", "warn");
        }

        const findTask = code => db.tasks.find(t => t.code === code);
        const shopItem = id => db.shop.find(i => i.id === id);

        function addPurchased(item, title = item.title, id = item.id) {
            let row = db.purchased.find(r => r.id === id);
            if (!row) {
                row = { id, title, total: 0, available: 0, pending: 0, used: 0 };
                db.purchased.unshift(row);
            }
            row.total += 1;
            if (BACKPACK.has(item.id) || id.startsWith("nick_")) row.available += 1;
            else if (DELIVERED.has(item.id)) row.pending += 1;
            else row.used += 1;
        }

        function pointSegDist(p, a, b) {
            const dx = b.x - a.x, dy = b.y - a.y;
            const len = dx * dx + dy * dy;
            const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
            return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
        }

        function nearPath(p, path) {
            if (path.length === 1) return Math.hypot(p.x - path[0].x, p.y - path[0].y) <= CONTRACT.wipeRadius;
            for (let i = 1; i < path.length; i += 1) {
                if (pointSegDist(p, path[i - 1], path[i]) <= CONTRACT.wipeRadius) return true;
            }
            return false;
        }

        // Три прохода тряпкой по одному месту очищают его полностью.
        function applyWipe(path) {
            const colors = new Set();
            let cleared = false;
            for (const d of db.board.drawings) {
                const strokes = [];
                for (const s of d.strokes) {
                    let chunk = [];
                    for (const p of s.points) {
                        if (nearPath(p, path)) {
                            colors.add(s.color);
                            p.hits = (p.hits ?? 0) + 1;
                            if (p.hits >= 3) {
                                cleared = true;
                                if (chunk.length > 1) strokes.push({ ...s, points: chunk });
                                chunk = [];
                                continue;
                            }
                        }
                        chunk.push(p);
                    }
                    if (chunk.length > 1) strokes.push({ ...s, points: chunk });
                }
                d.strokes = strokes;
                if (strokes.length) d.bounds = boundsOf(strokes);
            }
            db.board.drawings = db.board.drawings.filter(d => d.strokes.length);
            db.board.wipes.push({
                id: uid(),
                smudges: [{ color: [...colors][0] ?? "#f5f1df", points: path, strength: cleared ? 2 : 1 }],
            });
            db.board.revision += 1;
        }

        function validateWipe(path) {
            if (!Array.isArray(path) || path.length < 2 || path.length > CONTRACT.maxWipePoints) throw fail(400, "INVALID_BOARD_WIPE");
            let length = 0;
            for (let i = 1; i < path.length; i += 1) length += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
            const b = boundsOf([{ points: path }]);
            if (length > CONTRACT.maxWipeLength || Math.max(b.right - b.left, b.bottom - b.top) > CONTRACT.maxWipeSpan) {
                throw fail(422, "BOARD_WIPE_LIMIT_EXCEEDED");
            }
        }

        const overlaps = (a, b, gap = 4) => a.left < b.right + gap && a.right + gap > b.left && a.top < b.bottom + gap && a.bottom + gap > b.top;

        return {
            kind: "dev",

            load: wrap("load", () => {
                rollCycle();
                db.tasks.forEach(progress);
                return {
                    balance: db.balance,
                    refreshesInSec: Math.max(0, Math.round((db.cycleEndsAt - Date.now()) / 1e3)),
                    cycleStartsAt: db.cycleStartsAt,
                    tasks: db.tasks,
                };
            }),

            submit: wrap("submit", (code, link) => {
                const task = findTask(code);
                if (!task) throw fail(404, "404", "Задание не найдено");
                progress(task);
                const s = task.submission;
                if (task.completedAt || s?.status === "passed" || s?.status === "queued" || s?.status === "running" || (s?.status === "rejected" && s.attemptsLeft <= 0)) {
                    throw fail(409, "ATTEMPT_ALREADY_USED");
                }
                const attemptsUsed = (s?.attemptsUsed ?? 0) + 1;
                task.submission = sub("queued", { attemptsUsed, queuePosition: 1 + Math.floor(Math.random() * 4), link });
                db.subsStartedAt.set(code, Date.now());
                return task.submission;
            }),

            submissionStatus: wrap("submissionStatus", code => {
                const task = findTask(code);
                if (!task) return null;
                progress(task);
                return task.submission;
            }),

            completedTasks: wrap("completedTasks", before => {
                const start = before ? Number(before) : 0;
                const page = db.history.slice(start, start + 10);
                const next = start + 10 < db.history.length ? String(start + 10) : null;
                return { tasks: page, nextBefore: next };
            }),

            honorBoard: wrap("honorBoard", () => ({ entries: db.honor })),

            balance: wrap("balance", () => db.balance),

            myProfile: wrap("myProfile", () => {
                const p = db.profile;
                return {
                    aura: p.aura,
                    nickname: p.active,
                    nicknames: p.owned,
                    curtains: {
                        goal: p.curtains.goal,
                        raised: Math.min(p.curtains.fund, p.curtains.goal),
                        remaining: Math.max(0, p.curtains.goal - p.curtains.fund),
                        completed: p.curtains.hasCurtains,
                        closed: p.curtains.closed,
                    },
                };
            }),

            setNickname: wrap("setNickname", form => {
                if (form !== null && !db.profile.owned.includes(form)) throw fail(409, "NOT_OWNED");
                db.profile.active = form;
                return form;
            }),

            setCurtains: wrap("setCurtains", (_, closed) => {
                if (!db.profile.curtains.hasCurtains) throw fail(409, "NO_CURTAINS");
                db.profile.curtains.closed = closed;
                return closed;
            }),

            shop: wrap("shop", () => {
                if (cfg.shopMode === "timer" && Date.now() >= db.shopEndsAt) db.shopEndsAt = Date.now() + cfg.shopRefresh * 1e3;
                return {
                    balance: db.balance,
                    items: db.shop,
                    showcase: {
                        refreshesInSec: Math.max(1, Math.round((db.shopEndsAt - Date.now()) / 1e3)),
                        allItems: cfg.shopMode === "all",
                    },
                };
            }),

            boardShop: wrap("boardShop", () => ({
                balance: db.balance,
                items: db.shop.filter(i => i.id === "board_drawing" || i.id === "board_cloth"),
            })),

            buy: wrap("buy", (id, key, variant) => {
                if (db.buyResults.has(key)) return db.buyResults.get(key);
                const item = shopItem(id);
                if (!item) throw fail(409, "NOT_ON_SHOWCASE");
                if (!item.isAvailable) throw fail(409, "ITEM_NOT_AVAILABLE");
                if (item.perUser !== null && item.purchased >= item.perUser) {
                    throw fail(409, id === "aura_analyzer" ? "AURA_ALREADY_MEASURED" : "ALREADY_PURCHASED");
                }
                if (item.variants && !item.variants.some(v => v.id === variant)) throw fail(400, "INVALID_VARIANT");
                if (db.balance < item.price) throw fail(409, "INSUFFICIENT_CHALKS");

                db.balance -= item.price;
                item.purchased += 1;
                let result;
                if (id === "aura_analyzer") {
                    db.profile.aura = 40 + Math.floor(Math.random() * 61);
                    addPurchased(item);
                    result = { balance: db.balance, message: `Аура: ${db.profile.aura} из 100`, delivered: false };
                } else if (id === "random_nickname") {
                    const nickname = pick(NICKNAMES);
                    const duplicate = db.profile.owned.includes(nickname);
                    if (!duplicate) db.profile.owned.push(nickname);
                    addPurchased(item, nickname, `nick_${nickname.toLowerCase()}`);
                    result = { balance: db.balance, message: `Кликуха: ${nickname.toLocaleLowerCase("ru-RU")}`, delivered: false, nickname, duplicate };
                } else if (id === "school_bell") {
                    addPurchased(item);
                    result = { balance: db.balance, message: "Звонок прозвенел для тех, кто сейчас онлайн", delivered: false };
                } else {
                    if (BACKPACK.has(id)) item.owned += 1;
                    if (id === "board_drawing" || id === "board_cloth") db.inventory.push({ id: uid(), kind: id });
                    if (id === "profile_avatar") db.avatar.balance += 1;
                    addPurchased(item);
                    const delivered = DELIVERED.has(id);
                    const backpack = {
                        school_stickers: "Наклейка в рюкзаке — прилепи её на чужой профиль",
                        water_balloons: "Шарик в рюкзаке — кинь его в чужой профиль",
                        eraser: "Ластик в рюкзаке",
                        break_window: "Портфель в рюкзаке — можно бить чужое окно",
                        whoopee_cushion: "Подушка в рюкзаке — положи её на чужой профиль",
                    };
                    result = { balance: db.balance, message: delivered ? "Куплено! Через пару секунд появится в соцсети" : backpack[id] ?? "Куплено!", delivered };
                }
                db.buyResults.set(key, result);
                return result;
            }),

            purchased: wrap("purchased", () => db.purchased),

            avatar: wrap("avatar", () => {
                if (cfg.avatar === "arrives" && db.avatar.balance < 1 && Date.now() - bootAt > 5e3) db.avatar.balance = 1;
                return db.avatar;
            }),

            uploadAvatar: wrap("uploadAvatar", form => {
                const file = form.get("file");
                const id = `file-${uid()}`;
                return { id, url: file instanceof Blob ? URL.createObjectURL(file) : PENDING_AVATAR };
            }),

            deleteFile: wrap("deleteFile", () => undefined),

            installAvatar: wrap("installAvatar", (_, fileId) => {
                const a = db.avatar;
                if (!a.applicationsEnabled) throw fail(409, "PROFILE_AVATAR_PAUSED");
                if (a.balance < 1) throw fail(409, "PROFILE_AVATAR_PURCHASE_REQUIRED");
                a.balance -= 1;
                a.active = { revision: fileId, url: a.pending?.fileId === fileId ? a.pending.url : null };
                a.pending = null;
            }),

            board: wrap("board", () => ({ ...db.board, contract: CONTRACT })),

            boardInventory: wrap("boardInventory", () => db.inventory),

            boardTicket: wrap("boardTicket", () => `dev-ticket-${Date.now()}`),

            publishDrawing: wrap("publishDrawing", (itemId, strokes) => {
                const idx = db.inventory.findIndex(i => i.id === itemId && i.kind === "board_drawing");
                if (idx < 0) throw fail(409, "NOT_OWNED");
                const bounds = boundsOf(strokes);
                if (db.board.drawings.some(d => overlaps(d.bounds, bounds))) throw fail(409, "BOARD_DRAWING_OVERLAP");
                db.inventory.splice(idx, 1);
                const drawing = { id: uid(), strokes: clone(strokes), bounds, author: { id: ME, username: ME_AUTHOR.username, displayName: ME_AUTHOR.displayName }, authorVisible: true, createdAt: new Date().toISOString() };
                db.board.drawings.push(drawing);
                db.board.revision += 1;
                return { revision: db.board.revision, drawing };
            }),

            wipeBoard: wrap("wipeBoard", (itemId, path) => {
                const idx = db.inventory.findIndex(i => i.id === itemId && i.kind === "board_cloth");
                if (idx < 0) throw fail(409, "NOT_OWNED");
                validateWipe(path);
                db.inventory.splice(idx, 1);
                applyWipe(clone(path));
                return { revision: db.board.revision };
            }),

            wastePaper: wrap("wastePaper", () => db.waste),

            handInWastePaper: wrap("handInWastePaper", () => {
                const w = db.waste;
                if (w.mine <= 0) throw fail(409, "NO_WASTE_PAPER");
                const handedIn = w.mine;
                w.total += handedIn;
                w.handedIn += handedIn;
                w.mine = 0;
                return { total: w.total, mine: 0, myHandedIn: w.handedIn, handedIn };
            }),

            // для панели
            _applyWipe: applyWipe,
        };
    }

    // ─── Фейковый WebSocket общей доски ──────────────────────────────────

    const sockets = new Set();

    function presence() {
        const users = [{ id: ME, ...ME_AUTHOR }];
        for (let i = 0; users.length < Math.min(cfg.online, 10); i += 1) {
            const a = person(i);
            users.push({ id: `user-${i}`, username: a.username, displayName: a.displayName || a.username, avatar: a.avatar ?? "", avatarImageUrl: a.avatarImageUrl });
        }
        return { type: "presence.updated", onlineCount: cfg.online, users: users.slice(0, cfg.online) };
    }

    class FakeSocket {
        constructor(url) {
            this.url = url;
            this.readyState = 0;
            this.onopen = this.onmessage = this.onclose = null;
            log("WS: подключение…");
            setTimeout(() => {
                if (this.readyState !== 0) return;
                if (cfg.socket === "down") {
                    this.readyState = 3;
                    log("WS: не подключился (socket=down)", "err");
                    this.onclose?.({ code: 1006 });
                    return;
                }
                this.readyState = 1;
                sockets.add(this);
                log("WS: открыт");
                this.onopen?.({});
                setTimeout(() => this.emit(presence()), 150);
            }, cfg.latency + 300);
        }
        send(data) {
            if (data === "ping") setTimeout(() => this.readyState === 1 && this.onmessage?.({ data: "pong" }), 30);
        }
        close() {
            this.readyState = 3;
            sockets.delete(this);
        }
        emit(message) {
            if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(message) });
        }
        drop() {
            this.readyState = 3;
            sockets.delete(this);
            this.onclose?.({ code: 1006 });
        }
    }

    const broadcast = message => sockets.forEach(s => s.emit(message));

    // ─── Экспорт для пропатченного бандла ────────────────────────────────

    let api = null;

    window.__DEV = {
        cfg,
        token: TOKEN,
        ecoPin: ECO_PIN,
        wasteTarget: cfg.wasteTarget,   // общая цель сбора макулатуры

        FakeSocket,
        makeApi(P) {
            api = makeApi(P);
            return api;
        },
        boot() {
            log(`boot: ${cfg.boot}`);
            return Promise.resolve(cfg.boot === "failed" ? "native-failed" : "ready");
        },
        startScreen(resolve) {
            const hash = location.hash.replace(/^#\/?/, "");
            if (hash) return resolve(hash) ?? "main";
            const q = new URLSearchParams(location.search);
            return q.has("product") || q.has("profileId") ? "shop" : "main";
        },
        url(path, search) {
            return `${location.pathname}${search}#/${path}`;
        },
        externalNav(path) {
            log(`Переход наружу (в соцсеть): ${path}`, "warn");
        },
        bridge(message) {
            log(`Нативный мост: ${message}`, "warn");
        },
        log,
    };

})();
