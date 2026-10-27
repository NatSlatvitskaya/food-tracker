/* =========================================================
   app.js — трекер питания с ИИ
   Работает как Telegram Mini App и как обычная веб-страница.
   Все данные и ключи живут на сервере (Render + Supabase).
   В браузере остаётся только кэш для мгновенной отрисовки.
   ========================================================= */

'use strict';

/* =========================================================
   1. КОНФИГУРАЦИЯ
   ========================================================= */

/*
  СЕРВЕР. Все запросы к ИИ и базе идут сюда.
  Ключ OpenRouter живёт только в переменных окружения Render,
  в браузер он больше не попадает.
*/
const SERVER_URL = 'https://nutlet-food-agent.onrender.com';
const API_TIMEOUT_MS = 60000;

/*
  TELEGRAM MINI APP.
  initData — подписанная строка от Telegram. Сервер проверяет её HMAC-подписью,
  поэтому подделать чужой telegram_id нельзя.
  initDataUnsafe.user.id используем только для локального кэша и подписей в UI:
  доверять ему для доступа к данным нельзя, проверка всегда на сервере.
*/
const tg = typeof window !== 'undefined' ? window.Telegram?.WebApp : null;

if (tg) {
  try {
    tg.ready();
    tg.expand();
  } catch (err) {
    console.warn('Telegram WebApp не инициализировался:', err.message);
  }
}

/** Подписанная строка для заголовка x-telegram-init-data */
function telegramInitData() {
  return tg?.initData || '';
}

/** Локальный идентификатор для кэша. Для доступа к данным не используется */
function telegramUserId() {
  return String(tg?.initDataUnsafe?.user?.id || 'local');
}

/** Запущено ли внутри Telegram: от этого зависит авторизация */
function isTelegramContext() {
  return Boolean(telegramInitData());
}

// Ключи localStorage для данных
const STORAGE_KEYS = {
  profile: 'tracker.profile',
  goals: 'tracker.goals',
  metrics: 'tracker.metrics',
  meals: 'tracker.meals',
  // Заметки по дням: { 'YYYY-MM-DD': 'текст' }
  notes: 'tracker.notes',
};

/**
 * СТРУКТУРА ДАННЫХ ПО ДНЯМ
 *
 * Все записи привязаны к дате в формате YYYY-MM-DD — ключу дня.
 * Это основа для архива и для переноса в Telegram-бота: историю за любой
 * день можно получить одним запросом по ключу, без перебора всей базы.
 *
 *   tracker.meals   — массив приёмов пищи, у каждого поле date
 *   tracker.metrics — массив замеров, у каждого поле date
 *   tracker.notes   — объект { 'YYYY-MM-DD': 'текст заметки' }
 *
 * Индекс state.dayIndex строится из tracker.meals при загрузке и
 * после каждого изменения, сами данные в localStorage не дублируются.
 */
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Проверка и нормализация ключа дня */
function dayKey(value) {
  return DATE_KEY_RE.test(String(value || '')) ? String(value) : null;
}

/*
  ЦЕЛИ ПО ВЕСУ. Для каждой — своя формулировка для ИИ и резервные значения
  на случай, если модель недоступна. Проценты БЖУ взяты из ТЗ:
    похудение  — дефицит 15-20%, Б 25 / Ж 30 / У 45
    поддержание — баланс,        Б 20 / Ж 30 / У 50
    набор      — профицит 10-15%, Б 30 / Ж 25 / У 45

  Резервные граммы посчитаны по калорийности: белок и углеводы 4 ккал/г,
  жиры 9 ккал/г.
*/
const GOALS_META = {
  lose: {
    label: 'Похудение',
    defaults: { kcal: 1800, protein: 113, fats: 60, carbs: 203 },
    hint: 'Дефицит 15–20% от нормы поддержания, белки выше обычного',
    instruction:
      'Цель — снижение веса. Рассчитай норму поддержания и создай дефицит 15-20%. ' +
      'Распределение калорий: белки 35%, жиры 30%, углеводы 35%.',
  },
  maintain: {
    label: 'Поддержание формы',
    defaults: { kcal: 2000, protein: 100, fats: 67, carbs: 250 },
    hint: 'Баланс трат и потребления, без дефицита и профицита',
    instruction:
      'Цель — удержание веса. Норма равна суточным тратам, без дефицита и профицита. ' +
      'Распределение калорий: белки 25%, жиры 30%, углеводы 45%.',
  },
  gain: {
    label: 'Набор мышечной массы',
    defaults: { kcal: 2200, protein: 165, fats: 61, carbs: 248 },
    hint: 'Профицит 10–15%, больше белка для роста мышц',
    instruction:
      'Цель — набор мышечной массы. Рассчитай норму поддержания и добавь профицит 10-15%. ' +
      'Распределение калорий: белки 30%, жиры 25%, углеводы 45%.',
  },
};

const DEFAULT_GOAL = 'maintain';

/*
  РАСПРЕДЕЛЕНИЕ БЖУ ПО ЦЕЛИ (в процентах калорий).
  Проценты — основа и для ползунков в настройках, и для «Целевой» шкалы.
  Граммы всегда вычисляются из процентов, поэтому шкала и цели не расходятся.
*/
const MACRO_SPLIT_BY_GOAL = {
  lose:     { protein: 35, fats: 30, carbs: 35 }, // низкоуглеводный дефицит
  maintain: { protein: 25, fats: 30, carbs: 45 }, // здоровый баланс
  gain:     { protein: 30, fats: 25, carbs: 45 }, // качественный профицит
};

/** Калорийность грамма и подпись для каждого макронутриента */
const MACRO_META = {
  protein: { label: 'Белки', kcalPerGram: 4 },
  fats:    { label: 'Жиры', kcalPerGram: 9 },
  carbs:   { label: 'Углеводы', kcalPerGram: 4 },
};

const MACRO_KEYS = ['protein', 'fats', 'carbs'];

/*
  МИКРОНУТРИЕНТЫ. Нормы по умолчанию — из общих рекомендаций.
  Значение null означает «ИИ не вернул данных»: такая запись не попадает
  в сумму, чтобы не занижать клетчатку и не выдавать натрий за идеальный.
*/
const MICRO_META = {
  fiber:  { label: 'Клетчатка', unit: 'г',  goal: 25,   digits: 1 },
  sodium: { label: 'Натрий',    unit: 'мг', goal: 1500, digits: 0 },
  sugar:  { label: 'Сахар',     unit: 'г',  goal: 40,   digits: 1 },
};

const MICRO_KEYS = ['fiber', 'sodium', 'sugar'];

/*
  КАТЕГОРИИ ПРИЁМОВ ПИЩИ для диаграммы на Главной.
  Категория определяется по времени записи, а не выбором пользователя —
  так не нужно ничего спрашивать при добавлении еды.

  Окна: [from, to). Всё, что не попало в первые три, становится перекусом —
  ночь до 5 утра и поздний вечер после 23.
*/
const MEAL_CATEGORIES = [
  { key: 'breakfast', label: 'Завтрак', icon: '\u2600\ufe0f', color: '#34c759', from: 5, to: 11 },
  { key: 'lunch',     label: 'Обед',    icon: '\ud83c\udf7d\ufe0f', color: '#ff9f0a', from: 11, to: 16 },
  { key: 'dinner',    label: 'Ужин',    icon: '\ud83c\udf19', color: '#007aff', from: 16, to: 23 },
  { key: 'snack',     label: 'Перекус', icon: '\ud83c\udf4e', color: '#af52de', from: 23, to: 5 },
];

/** Категория по времени «HH:MM». Ночь и поздний вечер — перекус */
function mealCategoryFor(time) {
  const hour = Number(String(time || '').slice(0, 2));
  if (!Number.isFinite(hour)) return 'snack';

  const found = MEAL_CATEGORIES.find(
    (c) => c.key !== 'snack' && hour >= c.from && hour < c.to
  );
  return found ? found.key : 'snack';
}

/** Резервные цели под выбранную цель по весу */
/** Пресет распределения БЖУ для цели */
function defaultSplitFor(goal) {
  return { ...(MACRO_SPLIT_BY_GOAL[goal] || MACRO_SPLIT_BY_GOAL[DEFAULT_GOAL]) };
}

/**
 * Граммы из процентов калорий.
 * Белки и углеводы — 4 ккал/г, жиры — 9 ккал/г.
 */
function gramsFromSplit(kcal, split) {
  return {
    protein: roundTo((kcal * split.protein) / 100 / 4, 1),
    fats: roundTo((kcal * split.fats) / 100 / 9, 1),
    carbs: roundTo((kcal * split.carbs) / 100 / 4, 1),
  };
}

/** Полный объект целей: калории, граммы и проценты */
/**
 * Собирает цели из калорий и процентов.
 *
 * splitSource отвечает за подпись в настройках:
 *   'goal'   — проценты взяты из пресета цели (по умолчанию)
 *   'manual' — пользователь двигал ползунки сам
 */
function goalsFromSplit(kcal, split, splitSource = 'goal') {
  const cleanSplit = { ...split };
  return {
    kcal: roundTo(kcal, 0),
    ...gramsFromSplit(kcal, cleanSplit),
    split: cleanSplit,
    splitSource,
  };
}

function defaultGoalsFor(goal) {
  const meta = GOALS_META[goal] || GOALS_META[DEFAULT_GOAL];
  return goalsFromSplit(meta.defaults.kcal, defaultSplitFor(goal));
}

/**
 * Связанные ползунки: сумма всегда ровно 100.
 *
 * changed — какой ползунок двигали, value — его новое значение.
 * Оставшиеся проценты делятся между двумя другими пропорционально их
 * прежним значениям. Округление — методом наибольших остатков,
 * иначе сумма может дать 99 или 101.
 */
function distributeSplit(changed, value, current) {
  const next = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  const others = MACRO_KEYS.filter((k) => k !== changed);
  const rest = 100 - next;
  const baseSum = others.reduce((sum, k) => sum + (current[k] || 0), 0);

  const result = { [changed]: next, ...{} };

  if (baseSum <= 0) {
    // Оба оставшихся были нулями — делим поровну
    const base = Math.floor(rest / others.length);
    others.forEach((k, i) => {
      result[k] = i === 0 ? rest - base * (others.length - 1) : base;
    });
    return result;
  }

  const raw = others.map((k) => ((current[k] || 0) / baseSum) * rest);
  const floors = raw.map(Math.floor);
  let remainder = rest - floors.reduce((a, b) => a + b, 0);

  // Дробные части по убыванию: кому достанутся «лишние» проценты
  const byFraction = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);

  let idx = 0;
  while (remainder > 0) {
    floors[byFraction[idx % byFraction.length].i] += 1;
    remainder -= 1;
    idx += 1;
  }

  others.forEach((k, i) => {
    result[k] = floors[i];
  });

  return result;
}

/**
 * Приводит сохранённые цели к текущему формату.
 * У пользователей прошлых версий поля split нет — восстанавливаем его
 * из граммов, чтобы ползунки открылись на их реальных пропорциях.
 */
/** Старые пресеты v11 — если сохранённые проценты совпадают, это не ручная правка */
const LEGACY_SPLITS = [
  { protein: 25, fats: 30, carbs: 45 },
  { protein: 20, fats: 30, carbs: 50 },
  { protein: 30, fats: 25, carbs: 45 },
];

function isLegacyPreset(split) {
  return LEGACY_SPLITS.some(
    (p) => p.protein === split.protein && p.fats === split.fats && p.carbs === split.carbs
  );
}

function normalizeGoalsShape(goals, goal) {
  const kcal = roundTo(goals?.kcal, 0) || GOALS_META[goal]?.defaults?.kcal || 2000;

  if (goals?.split && MACRO_KEYS.every((k) => Number.isFinite(goals.split[k]))) {
    // Старый пресет без ручной правки — переводим на новый пресет цели
    if (goals.splitSource !== 'manual' && isLegacyPreset(goals.split)) {
      return goalsFromSplit(kcal, defaultSplitFor(goal), 'goal');
    }
    return goalsFromSplit(kcal, goals.split, goals.splitSource || 'manual');
  }

  const kcalFromMacros =
    (goals?.protein || 0) * 4 + (goals?.fats || 0) * 9 + (goals?.carbs || 0) * 4;

  if (kcalFromMacros > 0) {
    const split = {
      protein: Math.round(((goals.protein * 4) / kcalFromMacros) * 100),
      fats: Math.round(((goals.fats * 9) / kcalFromMacros) * 100),
      carbs: 0,
    };
    split.carbs = 100 - split.protein - split.fats;
    if (split.fats > 0 && split.protein > 0 && split.carbs > 0) {
      return goalsFromSplit(kcal, split);
    }
  }

  return goalsFromSplit(kcal, defaultSplitFor(goal));
}

// Длина окружности кольца (r = 60), совпадает с stroke-dasharray в CSS
const RING_LENGTH = 2 * Math.PI * 60;

const DEFAULT_PHOTO_LABEL = 'Загрузить фото / Сделать снимок';

// Сжатие фото: тяжёлый снимок с камеры (12 МП, ~5 МБ) превращается в ~150 КБ.
// 1024 px хватает модели, чтобы разглядеть состав блюда.
const PHOTO_MAX_SIDE = 1024;  // длинная сторона для отправки в ИИ
const PHOTO_QUALITY = 0.7;    // качество JPEG
const THUMB_MAX_SIDE = 512;   // длинная сторона для хранения в localStorage

/* =========================================================
   2. ХЕЛПЕРЫ
   ========================================================= */

/** Короткий доступ к элементу по id */
const $ = (id) => document.getElementById(id);

/** Создаёт элемент с классом и текстом (textContent — безопасно для ввода) */
function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** Читает JSON из localStorage, при ошибке возвращает fallback */
function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    console.warn(`Не удалось прочитать ${key}:`, err);
    return fallback;
  }
}

/** Сохраняет значение. Переполнение квоты не должно ломать приложение */
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.error(`Не удалось сохранить ${key}:`, err);
    return false;
  }
}

/** Дата YYYY-MM-DD по локальному времени (не UTC) */
function toISODate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** "2026-10-19" → "19 октября 2026" */
function formatLongDate(iso) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** "2026-10-19" → "19.10.2026" */
function formatShortDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

/** Приветствие по времени суток */
function greetingByHour(hour) {
  if (hour < 5) return 'Доброй ночи!';
  if (hour < 12) return 'Доброе утро!';
  if (hour < 18) return 'Добрый день!';
  return 'Добрый вечер!';
}

/** Процент выполнения цели, ограниченный 0–100 */
function percent(value, goal) {
  if (!goal) return 0;
  return Math.min(100, Math.round((value / goal) * 100));
}

/** Сумма КБЖУ по списку приёмов пищи */
function sumMeals(meals) {
  const totals = {
    kcal: 0, protein: 0, fats: 0, carbs: 0,
    // Микронутриенты суммируем только там, где ИИ вернул число
    fiber: 0, sodium: 0, sugar: 0,
    fiberCount: 0, sodiumCount: 0, sugarCount: 0,
  };

  console.groupCollapsed(`[Диагностика] Подсчет суммы за день (${meals.length} приемов пищи)`);

  meals.forEach((m, idx) => {
    const before = { kcal: totals.kcal, protein: totals.protein, fats: totals.fats, carbs: totals.carbs };

    totals.kcal += m.kcal || 0;
    totals.protein += m.protein || 0;
    totals.fats += m.fats || 0;
    totals.carbs += m.carbs || 0;

    MICRO_KEYS.forEach((key) => {
      const value = m[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        totals[key] += value;
        totals[`${key}Count`] += 1;
      }
    });

    const after = { kcal: totals.kcal, protein: totals.protein, fats: totals.fats, carbs: totals.carbs };
    console.log(
      `Прием #${idx + 1} "${m.title}":`,
      "\n  Было за день:", before,
      "\n  Добавляем:", { kcal: m.kcal, protein: m.protein, fats: m.fats, carbs: m.carbs },
      "\n  Стало:", after
    );
  });

  console.log("ИТОГО ЗА ДЕНЬ (сырые граммы):", {
    kcal: totals.kcal,
    protein: `${totals.protein}г`,
    fats: `${totals.fats}г`,
    carbs: `${totals.carbs}г`
  });
  console.groupEnd();

  return totals;
}

/**
 * Доли БЖУ в калориях. Считаем по калорийности грамма, а не по массе:
 * белки и углеводы по 4 ккал/г, жиры по 9 ккал/г. Так проценты
 * складываются в 100 и совпадают с ползунками целей.
 */
function calorieSplit(protein, fats, carbs) {
  const p = (protein || 0) * 4;
  const f = (fats || 0) * 9;
  const c = (carbs || 0) * 4;
  const total = p + f + c;

  if (total <= 0) return { protein: 0, fats: 0, carbs: 0 };

  return {
    protein: (p / total) * 100,
    fats: (f / total) * 100,
    carbs: (c / total) * 100,
  };
}

/** Округление до целого, безопасное для строк и undefined */
/** Округление до заданного числа знаков после запятой */
function roundTo(value, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function round(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

/* =========================================================
   3. JSON ОТ МОДЕЛИ
   ========================================================= */


/* =========================================================
   4. СОСТОЯНИЕ
   ========================================================= */

const state = {
  profile: null,
  goals: defaultGoalsFor(DEFAULT_GOAL),
  metrics: [],
  meals: [],
  pendingPhoto: null,   // { name, dataUrl, thumb } выбранного фото
  photoTask: null,      // Promise обработки фото (чтобы дождаться его перед отправкой)
  existingPhoto: '',    // фото из редактируемой записи (если новое не выбрано)
  editingMealId: null,  // id приёма пищи в режиме правки, иначе null
  goalDraft: DEFAULT_GOAL, // выбранная цель в онбординге
  dayIndex: {},
  serverHistory: null, // ответ /api/history за сегодня            // приёмы пищи по датам YYYY-MM-DD
};

/**
 * Группирует приёмы пищи по дате YYYY-MM-DD.
 * Нужно для будущего архивного календаря: чтобы отдать историю за день,
 * не перебирая весь массив. Ключ — дата, значение — массив записей.
 *
 * Записи без корректной даты попадают в бакет 'unknown' и не теряются.
 */
function indexMealsByDay(meals) {
  const index = {};

  (meals || []).forEach((meal) => {
    const day = dayKey(meal?.date) || 'unknown';
    if (!index[day]) index[day] = [];
    index[day].push(meal);
  });

  // Сортировка внутри дня по времени — стабильный порядок для архива
  Object.values(index).forEach((list) => {
    list.sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
  });

  return index;
}

/** Заметка за день. Пустая строка удаляет запись. */
function saveDayNote(day, text) {
  const key = dayKey(day);
  if (!key) return false;

  const notes = load(STORAGE_KEYS.notes, {});
  const clean = String(text || '').trim().slice(0, 500);

  if (clean) {
    notes[key] = clean;
  } else {
    delete notes[key];
  }
  return save(STORAGE_KEYS.notes, notes);
}

/** Заметка за конкретный день или null */
function getDayNote(day) {
  const key = dayKey(day);
  if (!key) return null;
  const notes = load(STORAGE_KEYS.notes, {});
  return notes[key] ?? null;
}

/** История за конкретный день: приёмы пищи и суммарные КБЖУ */
function mealsForDay(day) {
  const key = dayKey(day);
  const list = (key && state.dayIndex?.[key]) || [];
  const metric = state.metrics.find((m) => dayKey(m.date) === key) || null;
  return {
    day: key,
    meals: list,
    totals: sumMeals(list),
    metric,
    note: key ? getDayNote(key) : null,
  };
}

/** Список дней, по которым есть записи, от новых к старым */
function availableDays() {
  return Object.keys(state.dayIndex || {})
    .filter((day) => day !== 'unknown')
    .sort((a, b) => b.localeCompare(a));
}

/**
 * Загрузка данных.
 *
 * Сначала читаем локальный кэш — интерфейс рисуется сразу, без ожидания сети.
 * Затем запрашиваем сервер; если он ответил, кэш заменяется свежими данными.
 * Если сети нет, приложение продолжает работать на кэше.
 */
function loadStateFromCache() {
  state.profile = load(STORAGE_KEYS.profile, null);
  state.goalDraft = state.profile?.goal || DEFAULT_GOAL;

  const storedGoals = load(STORAGE_KEYS.goals, null);
  state.goals = storedGoals
    ? normalizeGoalsShape(storedGoals, state.goalDraft)
    : defaultGoalsFor(state.goalDraft);

  state.metrics = load(STORAGE_KEYS.metrics, []);
  state.meals = load(STORAGE_KEYS.meals, []);
  state.dayIndex = indexMealsByDay(state.meals);
}

/**
 * Синхронизация с сервером.
 * Ошибку не пробрасываем: приложение должно открыться и без сети.
 */
async function syncFromServer() {
  try {
    const data = await fetchProfile();

    if (!data) {
      // Профиля на сервере нет — показываем онбординг
      state.profile = null;
      showOnboarding();
      return;
    }

    state.profile = data.profile;
    state.goalDraft = data.profile.goal;
    state.goals = normalizeGoalsShape(data.goals, data.profile.goal);

    save(STORAGE_KEYS.profile, state.profile);
    save(STORAGE_KEYS.goals, state.goals);

    // Замеры
    const metrics = await fetchMetrics().catch(() => null);
    if (metrics) {
      state.metrics = metrics;
      save(STORAGE_KEYS.metrics, metrics);
    }

    // Архив за сегодня
    const history = await apiFetch(`/api/history?date=${toISODate()}`).catch(() => null);
    if (history) {
      state.serverHistory = history;
      state.meals = (history.meals || []).map((m) => ({
        id: m.id,
        date: m.date,
        time: m.time,
        category: m.category,
        title: m.title,
        ingredients: [],
        drinks: [],
        grams: 0,
        ml: 0,
        kcal: m.calories,
        protein: Number(m.protein),
        fats: Number(m.fats),
        carbs: Number(m.carbs),
        fiber: m.fiber,
        sodium: m.sodium,
        sugar: m.sugar,
        ai_recommendation: m.ai_recommendation || '',
        items: m.items || [],
        photo: '',
      }));
      state.dayIndex = indexMealsByDay(state.meals);
      save(STORAGE_KEYS.meals, state.meals);
    }

    if (state.profile) hideOnboarding();
    renderAll();
  } catch (err) {
    console.warn('Синхронизация с сервером не удалась, работаем на кэше:', err.message);
    if (err.status === 401) {
      toast('Откройте трекер из Telegram — без этого данные не загрузятся', 'error');
    }
  }
}

/** Замер за сегодня заменяет предыдущий, иначе добавляется новый */
/**
 * Один замер на один день: ищем запись по ключу даты, а не только
 * последнюю. Так новый замер за сегодня заменит существующий, даже если
 * массив уже содержит более поздние даты.
 */
function upsertMetric(entry) {
  const day = dayKey(entry.date);
  if (!day) return;

  const index = state.metrics.findIndex((m) => dayKey(m.date) === day);
  const record = { ...entry, date: day };

  if (index >= 0) {
    state.metrics[index] = record;
  } else {
    state.metrics.push(record);
  }

  // Держим массив отсортированным по дате — удобно для архива
  state.metrics.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  save(STORAGE_KEYS.metrics, state.metrics);
}

/* =========================================================
   5. КЛЮЧ API
   ========================================================= */




/* =========================================================
   6. ЗАПРОСЫ К OPENROUTER
   ========================================================= */

/**
 * Отправляет сообщения в модель и возвращает текст ответа.
 * content — либо строка, либо массив частей (для фото).
 */


/* =========================================================
   7. ФОТО: ЧТЕНИЕ И СЖАТИЕ
   ========================================================= */

/** Открывает файл как изображение через object URL (без base64 — меньше памяти) */
function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();

    // Страховка от «зависшей» картинки: битый или очень тяжёлый файл
    const guard = setTimeout(() => {
      URL.revokeObjectURL(url);
      reject(new Error('Фото слишком большое или повреждено'));
    }, 20000);

    img.onload = () => {
      clearTimeout(guard);
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(guard);
      URL.revokeObjectURL(url);
      reject(new Error('Это не изображение или формат не поддерживается'));
    };
    img.src = url;
  });
}

/**
 * Рисует изображение на canvas, уменьшая до maxSide по длинной стороне,
 * и возвращает JPEG в Base64 нужного качества.
 *
 * Зачем canvas: камера Samsung на 12 МП даёт файл 4–8 МБ. Если отправить
 * его в OpenRouter как есть, base64 раздувает размер ещё на треть,
 * запрос уходит долго, а модель всё равно не видит больше, чем 1024 px.
 */
function compressImage(img, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Белая подложка: JPEG не хранит прозрачность, иначе PNG уйдёт в чёрный
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, width, height);

  try {
    return canvas.toDataURL('image/jpeg', quality);
  } catch (err) {
    console.warn('Canvas не смог сжать фото:', err);
    return null;
  }
}

/**
 * Готовит два варианта одного снимка:
 *   dataUrl — 1024 px для отправки в ИИ
 *   thumb   — 512 px для карточки в истории (экономит localStorage)
 */
/* =========================================================
   СЕТЬ: обращения к серверу
   ========================================================= */

/**
 * Обёртка над fetch к нашему серверу.
 *
 * - Подставляет базовый адрес.
 * - Прикладывает подписанный initData от Telegram в заголовке.
 * - Держит таймаут: анализ фото может идти до минуты.
 * - Разбирает ошибку сервера и бросает Error с понятным текстом.
 */
async function apiFetch(path, { method = 'GET', body = null, timeoutMs = API_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers = { 'x-telegram-init-data': telegramInitData() };
  if (body !== null) headers['Content-Type'] = 'application/json';

  try {
    const response = await fetch(`${SERVER_URL}${path}`, {
      method,
      signal: controller.signal,
      headers,
      body: body !== null ? JSON.stringify(body) : undefined,
    });

    let data = null;
    try {
      data = await response.json();
    } catch (_) {
      /* тело не JSON — оставим null */
    }

    if (!response.ok) {
      const error = new Error(data?.error || `Сервер ответил ${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }

    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeout = new Error('Сервер не ответил за минуту. Попробуйте ещё раз');
      timeout.status = 'timeout';
      throw timeout;
    }
    // fetch падает TypeError, когда запрос не ушёл: сеть, CORS или сервер спит
    if (err instanceof TypeError) {
      const network = new Error(
        'Нет связи с сервером. Проверьте интернет — на бесплатном тарифе Render сервис засыпает, ' +
          'первый запрос может занять до минуты'
      );
      network.status = 'network';
      throw network;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Профиль и цели с сервера. 404 значит «профиля ещё нет» */
async function fetchProfile() {
  try {
    const data = await apiFetch('/api/profile');
    return data;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/** Сохраняет профиль на сервере. Возвращает { profile, goals } */
async function saveProfileRemote(profile) {
  const data = await apiFetch('/api/profile', { method: 'POST', body: { profile } });
  return data;
}

/** Сохраняет ручную раскладку БЖУ */
async function saveGoalsRemote(goals) {
  const data = await apiFetch('/api/goals', {
    method: 'POST',
    body: { kcal: goals.kcal, split: goals.split },
  });
  return data;
}

/** Замеры с сервера */
async function fetchMetrics() {
  const data = await apiFetch('/api/metrics');
  return data.metrics || [];
}

/** Сохраняет замер на сервере */
async function saveMetricRemote(entry) {
  await apiFetch('/api/metrics', { method: 'POST', body: entry });
}

async function preparePhoto(file) {
  const img = await loadImageFromFile(file);

  const dataUrl = compressImage(img, PHOTO_MAX_SIDE, PHOTO_QUALITY);
  if (!dataUrl) {
    throw new Error('Не удалось сжать фото');
  }

  const thumb = compressImage(img, THUMB_MAX_SIDE, PHOTO_QUALITY) || dataUrl;
  return { name: file.name, dataUrl, thumb };
}

/** Размер data URL в килобайтах (для подписи под полем) */
function dataUrlSizeKb(dataUrl) {
  return Math.round((dataUrl.length * 0.75) / 1024);
}

/* =========================================================
   8. ИНТЕРФЕЙС: КНОПКИ В РЕЖИМЕ ОЖИДАНИЯ
   ========================================================= */

/**
 * Переводит кнопку в состояние "ИИ анализирует...".
 * Возвращает функцию, которая вернёт исходный текст.
 */
function setButtonLoading(button, text = 'ИИ анализирует…') {
  const original = button.textContent;
  button.disabled = true;
  button.classList.add('is-loading');
  button.dataset.originalText = original;
  button.textContent = '';
  const spinner = el('span', 'spinner');
  const label = el('span', '', text);
  button.append(spinner, label);
  return () => {
    button.disabled = false;
    button.classList.remove('is-loading');
    button.replaceChildren(document.createTextNode(original));
  };
}

/** Короткое всплывающее сообщение внизу экрана */
function toast(message, kind = 'info') {
  const node = el('div', `toast toast-${kind}`, message);
  document.body.appendChild(node);
  requestAnimationFrame(() => node.classList.add('show'));
  setTimeout(() => {
    node.classList.remove('show');
    setTimeout(() => node.remove(), 300);
  }, 4000);
}

/** Показывает текст ошибки внутри формы. Пустая строка — убрать */
function setFormError(container, message) {
  let box = container.querySelector('.form-error');
  if (!message) {
    if (box) box.remove();
    return;
  }
  if (!box) {
    box = el('p', 'form-error');
    container.appendChild(box);
  }
  box.textContent = message;
}

/* =========================================================
   9. НАВИГАЦИЯ
   ========================================================= */

/** Показывает экран по имени и подсвечивает кнопку таббара */
function showScreen(name) {
  document.querySelectorAll('.screen').forEach((section) => {
    section.classList.toggle('active', section.id === `screen-${name}`);
  });
  document.querySelectorAll('.tab-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.screen === name);
  });
  window.scrollTo(0, 0);
}

function initTabs() {
  document.querySelectorAll('.tab-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      showScreen(btn.dataset.screen);
      renderAll();
    });
  });
}

/* =========================================================
   10. ОНБОРДИНГ
   ========================================================= */

function showOnboarding() {
  document.body.classList.add('is-onboarding');
  showScreen('onboarding');
}

function hideOnboarding() {
  document.body.classList.remove('is-onboarding');
  showScreen('home');
}

function initOnboarding() {
  if (state.profile) {
    hideOnboarding();
  } else {
    showOnboarding();
  }
  $('onboarding-form').addEventListener('submit', handleOnboardingSubmit);
  initGoalPicker();
}

/** Сегментированный переключатель «Ваша цель» */
/** Подсвечивает выбранный сегмент в указанном контейнере */
function paintSegmented(container, goal) {
  container.querySelectorAll('.segmented-item').forEach((btn) => {
    const active = btn.dataset.goal === goal;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', String(active));
  });
}

function initGoalPicker() {
  const container = $('goal-segmented');
  const buttons = [...container.querySelectorAll('.segmented-item')];

  const paint = (goal) => {
    paintSegmented(container, goal);

    // Подсказка объясняет, что именно означает выбранная цель
    const meta = GOALS_META[goal] || GOALS_META[DEFAULT_GOAL];
    $('goal-hint').textContent = meta.hint;
  };

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      state.goalDraft = btn.dataset.goal;
      paint(state.goalDraft);
    });
  });

  paint(state.goalDraft);
}


/** Приводит ответ модели к внутреннему виду целей */
/**
 * Разбирает ответ модели по целям.
 * Модель отдаёт граммы — из них восстанавливаем проценты калорий,
 * чтобы ползунки и «Целевая» шкала показывали ту же картину.
 */

/**
 * Кнопка "Рассчитать цель через ИИ-агента".
 * ВРЕМЕННАЯ ЧАСТЬ: при ошибке сети цели остаются дефолтными,
 * чтобы пользователь не оказался заперт на стартовом экране.
 */
/**
 * Сохранение профиля из онбординга.
 * Норму калорий и проценты БЖУ считает сервер: ключ OpenRouter
 * и логика расчёта живут там, в браузере их больше нет.
 */
async function handleOnboardingSubmit(event) {
  event.preventDefault();

  const form = event.target;
  const button = form.querySelector('button[type="submit"]');
  const num = (name) => Number(form.elements[name].value);

  const profile = {
    currentWeight: num('current-weight'),
    waist: num('waist'),
    hips: num('hips'),
    glutes: num('glutes'),
    age: num('age'),
    targetWeight: num('target-weight'),
    goal: state.goalDraft,
  };

  const restore = setButtonLoading(button, 'Считаем норму…');
  setFormError(form, '');

  let saved = null;
  try {
    saved = await saveProfileRemote(profile);

    // Первый замер сразу уходит в историю прогресса
    await saveMetricRemote({
      date: toISODate(),
      weight: profile.currentWeight,
      waist: profile.waist,
      hips: profile.hips,
      glutes: profile.glutes,
    }).catch((err) => console.warn('Замер не сохранён:', err.message));

    state.metrics = await fetchMetrics().catch(() => []);
  } catch (err) {
    console.error('Профиль не сохранён:', err);
    setFormError(form, err.message);
    toast(err.message, 'error');
    return;
  } finally {
    restore();
  }

  state.profile = saved.profile;
  state.goals = normalizeGoalsShape(saved.goals, saved.profile.goal);

  // Локальная копия: нужна для мгновенной отрисовки при следующем открытии
  save(STORAGE_KEYS.profile, state.profile);
  save(STORAGE_KEYS.goals, state.goals);

  hideOnboarding();
  renderAll();
  toast('Профиль сохранён', 'success');
}

/* =========================================================
   11. МОДАЛЬНЫЕ ОКНА
   ========================================================= */

function openModal(modal) {
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
}

function closeModal(modal) {
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
}

function closeAllModals() {
  document.querySelectorAll('.modal.open').forEach((modal) => closeModal(modal));
}

function initModals() {
  $('btn-add-meal').addEventListener('click', openMealModalForNew);

  // Карточки истории перерисовываются, поэтому слушаем контейнер,
  // а не каждую кнопку (делегирование)
  $('meal-list').addEventListener('click', (event) => {
    const button = event.target.closest('.meal-edit');
    if (!button) return;
    openMealModalForEdit(Number(button.dataset.editId));
  });

  $('btn-add-metrics').addEventListener('click', () => {
    fillMetricsForm();
    openModal($('modal-add-metrics'));
  });

  document.querySelectorAll('[data-close-modal]').forEach((element) => {
    element.addEventListener('click', () => closeModal(element.closest('.modal')));
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeAllModals();
  });
}

/* =========================================================
   12. ПРИЁМ ПИЩИ: ФОТО
   ========================================================= */

function resetMealForm() {
  $('form-meal').reset();
  state.pendingPhoto = null;
  state.photoTask = null;
  state.existingPhoto = '';
  state.editingMealId = null;
  $('meal-photo-name').textContent = DEFAULT_PHOTO_LABEL;
  setFormError($('form-meal'), '');
  resetIngredients();
}

/** Выбор файла: читаем, уменьшаем, показываем имя */
function handlePhotoChange(event) {
  const file = event.target.files[0];
  state.pendingPhoto = null;
  state.photoTask = null;

  if (!file) {
    $('meal-photo-name').textContent = DEFAULT_PHOTO_LABEL;
    return;
  }

  $('meal-photo-name').textContent = 'Обработка фото…';

  // Сохраняем Promise, чтобы отправка могла его дождаться
  state.photoTask = (async () => {
    try {
      const prepared = await preparePhoto(file);
      state.pendingPhoto = prepared;
      // Показываем имя и вес сжатого файла — видно, что фото не «тяжёлое»
      $('meal-photo-name').textContent =
        `${prepared.name} · ${dataUrlSizeKb(prepared.dataUrl)} КБ`;
    } catch (err) {
      state.pendingPhoto = null;
      $('meal-photo-name').textContent = DEFAULT_PHOTO_LABEL;
      setFormError($('form-meal'), 'Не удалось прочитать фото. Попробуйте другой файл.');
    }
  })();
}



/* =========================================================
   12б. ИНГРЕДИЕНТЫ: СТРОКИ ВВОДА
   ========================================================= */

/** Сумма весов всех ингредиентов */
function totalGrams(ingredients) {
  return ingredients.reduce((sum, i) => sum + i.grams, 0);
}

/** Сумма объёмов всех напитков, мл */
function totalMl(drinks) {
  return drinks.reduce((sum, d) => sum + (d.ml || 0), 0);
}

/**
 * Читает строки из контейнера. Поле веса называется .ingredient-grams
 * в обоих блоках (еда и напитки) — различается только единица измерения.
 */
function readRows(containerId, key = 'grams') {
  return [...$(containerId).querySelectorAll('.ingredient-row')]
    .map((row) => ({
      name: row.querySelector('.ingredient-name').value.trim(),
      [key]: Number(row.querySelector('.ingredient-grams').value),
    }))
    .filter((item) => item.name && item[key] > 0);
}

const readIngredients = () => readRows('ingredients', 'grams');
const readDrinks = () => readRows('drinks', 'ml');

/** Пересчитывает подпись «Еда: N г · Напитки: M мл» */
function updateMealTotal() {
  const food = totalGrams(readIngredients());
  const drinks = totalMl(readDrinks());
  $('meal-total').textContent = `Еда: ${food} г · Напитки: ${drinks} мл`;
}

/**
 * Добавляет строку продукта или напитка.
 *
 * containerId — 'ingredients' | 'drinks'
 * unit        — 'г' | 'мл'
 * removable   — можно ли удалять последнюю строку (у еды нельзя, у напитков можно)
 */
function addRow(containerId, unit, removable) {
  const container = $(containerId);
  const row = el('div', 'ingredient-row');

  const nameInput = el('input', 'ingredient-name');
  nameInput.type = 'text';
  nameInput.placeholder = containerId === 'drinks' ? 'Напиток' : 'Продукт';
  nameInput.autocomplete = 'off';

  const amountInput = el('input', 'ingredient-grams');
  amountInput.type = 'number';
  amountInput.inputMode = 'numeric';
  amountInput.min = '1';
  amountInput.placeholder = unit;

  const remove = el('button', 'ingredient-remove', '×');
  remove.type = 'button';
  remove.setAttribute('aria-label', 'Удалить строку');

  const sync = () => {
    updateMealTotal();
    const count = container.querySelectorAll('.ingredient-row').length;
    container.querySelectorAll('.ingredient-remove').forEach((btn) => {
      btn.disabled = removable ? count === 0 : count <= 1;
    });
  };

  nameInput.addEventListener('input', sync);
  amountInput.addEventListener('input', sync);

  remove.addEventListener('click', () => {
    const count = container.querySelectorAll('.ingredient-row').length;
    if (!removable && count <= 1) return;
    row.remove();
    sync();
  });

  // Enter в поле количества добавляет новую строку — удобно на телефоне
  amountInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addRow(containerId, unit, removable);
    const inputs = container.querySelectorAll('.ingredient-name');
    inputs[inputs.length - 1].focus();
  });

  row.append(nameInput, amountInput, remove);
  container.appendChild(row);
  sync();
  return row;
}

/** Еда: минимум одна строка обязательна */
function addIngredientRow(name = '', grams = '', focus = false) {
  const row = addRow('ingredients', 'г', false);
  if (name) row.querySelector('.ingredient-name').value = name;
  if (grams !== '') row.querySelector('.ingredient-grams').value = grams;
  if (focus) row.querySelector('.ingredient-name').focus();
  return row;
}

/** Напитки: полностью необязательны, стартуют с одной пустой строки */
function addDrinkRow(name = '', ml = '', focus = false) {
  const row = addRow('drinks', 'мл', true);
  if (name) row.querySelector('.ingredient-name').value = name;
  if (ml !== '') row.querySelector('.ingredient-grams').value = ml;
  if (focus) row.querySelector('.ingredient-name').focus();
  return row;
}

/** Очищает оба блока и оставляет по одной пустой строке */
function resetIngredients() {
  $('ingredients').replaceChildren();
  $('drinks').replaceChildren();
  addIngredientRow();
  addDrinkRow();
}

/* =========================================================
   13. ПРИЁМ ПИЩИ: ОТПРАВКА АГЕНТУ
   ========================================================= */

/** Проверяет и нормализует распознанный приём пищи */
/**
 * Позиции из ответа модели. Некорректные строки отбрасываются.
 * Возвращает массив {name, grams, kcal, protein, fats, carbs} или [].
 */
function parseItems(raw) {
  if (!Array.isArray(raw)) return [];
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  return raw
    .filter((it) => it && typeof it === 'object' && String(it.name || '').trim())
    .map((it) => ({
      name: String(it.name).trim().slice(0, 80),
      grams: num(it.grams ?? it.ml),
      kcal: num(it.calories),
      protein: num(it.protein),
      fats: num(it.fat ?? it.fats),
      carbs: num(it.carbs),
    }));
}

/**
 * Итог приёма. Если модель прислала позиции, итог — сумма позиций
 * (карточка всегда сходится со списком). Иначе — итог из ответа модели.
 */
function totalsFromItems(items, fallback) {
  if (!items.length) return { ...fallback, source: 'model' };
  const sum = items.reduce(
    (acc, it) => ({
      kcal: acc.kcal + it.kcal,
      protein: acc.protein + it.protein,
      fats: acc.fats + it.fats,
      carbs: acc.carbs + it.carbs,
    }),
    { kcal: 0, protein: 0, fats: 0, carbs: 0 }
  );
  if (sum.kcal > 0 && Math.abs(sum.kcal - (fallback.kcal || 0)) > 0) {
    console.warn('Итог модели не совпал с суммой позиций:', {
      модель: fallback.kcal, сумма: Math.round(sum.kcal),
    });
  }
  return {
    kcal: Math.round(sum.kcal),
    protein: Math.round(sum.protein),
    fats: Math.round(sum.fats),
    carbs: Math.round(sum.carbs),
    source: 'items',
  };
}

function normalizeMeal(data) {
  // Число или null. null значит «модель не вернула» — в сумму такое не идёт,
  // иначе клетчатка окажется ниже реальной, а натрий — идеальным
  const micro = (value) => {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  const items = parseItems(data.items);
  const totals = totalsFromItems(items, {
    kcal: round(data.calories),
    protein: round(data.protein),
    fats: round(data.fat ?? data.fats),
    carbs: round(data.carbs),
  });

  const meal = {
    title: String(data.title || 'Приём пищи').slice(0, 80),
    kcal: totals.kcal,
    protein: totals.protein,
    fats: totals.fats,
    carbs: totals.carbs,
    items,
    totalSource: totals.source,
    fiber: micro(data.fiber),
    sodium: micro(data.sodium),
    sugar: micro(data.sugar),
    // Совет ИИ при перекосе БЖУ. Пустая строка — совета нет
    ai_recommendation:
      typeof data.ai_recommendation === 'string'
        ? data.ai_recommendation.trim().slice(0, 300)
        : '',
  };

  const valid = meal.kcal > 0 && meal.kcal < 5000;
  return valid ? meal : null;
}

/**
 * Отправка приёма пищи на сервер.
 *
 * Сервер сам:
 *  - подставляет ключ OpenRouter;
 *  - знает цель и проценты БЖУ пользователя;
 *  - сохраняет приём в Supabase;
 *  - возвращает готовые цифры и совет ИИ.
 */
async function handleMealSubmit(event) {
  event.preventDefault();

  const form = event.target;
  const button = form.querySelector('button[type="submit"]');

  setFormError(form, '');

  const ingredients = readIngredients();
  const drinks = readDrinks();

  if (!ingredients.length && !drinks.length && !state.pendingPhoto?.dataUrl) {
    setFormError(form, 'Добавьте хотя бы один продукт, напиток или фото.');
    return;
  }

  const nameInput = $('meal-name').value.trim();
  const restore = setButtonLoading(button, 'ИИ анализирует…');

  try {
    // Фото могло ещё обрабатываться — дождёмся, иначе уйдёт запрос без картинки
    if (state.photoTask) await state.photoTask;

    const now = new Date();
    const time = now.toTimeString().slice(0, 5);

    const data = await apiFetch('/api/analyze-meal', {
      method: 'POST',
      body: {
        ingredients,
        drinks,
        photo: state.pendingPhoto?.dataUrl || '',
        title: nameInput,
        time,
        date: toISODate(now),
      },
    });

    const meal = data.meal;
    console.log('Приём сохранён на сервере:', meal);

    // Собираем запись для локального кэша и карточки истории
    const record = {
      id: meal.id,
      date: meal.date,
      time: meal.time,
      category: meal.category || mealCategoryFor(meal.time),
      title: meal.title,
      ingredients,
      drinks,
      grams: totalGrams(ingredients),
      ml: totalMl(drinks),
      kcal: meal.calories,
      protein: meal.protein,
      fats: meal.fats,
      carbs: meal.carbs,
      fiber: meal.fiber,
      sodium: meal.sodium,
      sugar: meal.sugar,
      ai_recommendation: meal.ai_recommendation || '',
      items: meal.items || [],
      photo: state.pendingPhoto?.thumb || state.existingPhoto || '',
    };

    if (state.editingMealId !== null) {
      const index = state.meals.findIndex((m) => m.id === state.editingMealId);
      if (index >= 0) {
        // Правка сохраняется как новый приём: старую запись убираем из кэша
        state.meals[index] = record;
      } else {
        state.meals.push(record);
      }
    } else {
      state.meals.push(record);
    }

    state.dayIndex = indexMealsByDay(state.meals);
    save(STORAGE_KEYS.meals, state.meals);

    const wasEditing = state.editingMealId !== null;
    closeModal($('modal-add-meal'));
    renderAll();
    toast(
      wasEditing ? `Обновлено: ${meal.calories} ккал` : `${meal.calories} ккал · записано`,
      'success'
    );
  } catch (err) {
    console.error('Распознавание не удалось:', err);
    setFormError(form, err.message);
    toast(err.message, 'error');
  } finally {
    restore();
  }
}

/* =========================================================
   13б. РЕДАКТИРОВАНИЕ ПРИЁМА ПИЩИ
   ========================================================= */

/** Открывает шторку пустой — для нового приёма */
function openMealModalForNew() {
  resetMealForm();
  $('modal-add-meal-title').textContent = 'Добавить прием пищи';
  $('btn-send-meal').textContent = 'Отправить агенту';
  openModal($('modal-add-meal'));
}

/**
 * Открывает шторку с данными существующей записи.
 * Пользователь может дописать продукт или напиток, а при сохранении
 * запись перезаписывается новым результатом ИИ.
 */
function openMealModalForEdit(id) {
  const meal = state.meals.find((m) => m.id === id);
  if (!meal) return;

  resetMealForm();
  state.editingMealId = meal.id;
  state.existingPhoto = meal.photo || '';

  $('modal-add-meal-title').textContent = 'Изменить приём пищи';
  $('btn-send-meal').textContent = 'Пересчитать';

  $('meal-name').value = meal.title || '';

  // Восстанавливаем еду
  $('ingredients').replaceChildren();
  (meal.ingredients || []).forEach((i) => addIngredientRow(i.name, i.grams));
  if (!(meal.ingredients || []).length) addIngredientRow();

  // Восстанавливаем напитки
  $('drinks').replaceChildren();
  (meal.drinks || []).forEach((d) => addDrinkRow(d.name, d.ml ?? d.grams));
  if (!(meal.drinks || []).length) addDrinkRow();

  updateMealTotal();

  if (meal.photo) {
    $('meal-photo-name').textContent = 'Фото сохранено — можно заменить';
  }

  openModal($('modal-add-meal'));
}

/* =========================================================
   14. ЗАМЕРЫ
   ========================================================= */

function fillMetricsForm() {
  const last = state.metrics[state.metrics.length - 1];
  if (!last) return;
  $('new-weight').value = last.weight;
  $('new-waist').value = last.waist;
  $('new-hips').value = last.hips;
  $('new-glutes').value = last.glutes;
}

/** Новый замер: уходит на сервер, локальный кэш обновляется */
async function handleMetricsSubmit(event) {
  event.preventDefault();

  const entry = {
    date: toISODate(),
    weight: Number($('new-weight').value),
    waist: Number($('new-waist').value),
    hips: Number($('new-hips').value),
    glutes: Number($('new-glutes').value),
  };

  const values = [entry.weight, entry.waist, entry.hips, entry.glutes];
  if (values.some((v) => !(v > 0))) return;

  const button = event.target.querySelector('button[type="submit"]');
  const restore = setButtonLoading(button, 'Сохраняем…');

  try {
    await saveMetricRemote(entry);

    // Держим локальный список в том же виде, что на сервере: один замер на дату
    const index = state.metrics.findIndex((m) => m.date === entry.date);
    if (index >= 0) state.metrics[index] = entry;
    else state.metrics.push(entry);
    state.metrics.sort((a, b) => String(a.date).localeCompare(String(b.date)));

    save(STORAGE_KEYS.metrics, state.metrics);

    closeModal($('modal-add-metrics'));
    renderAll();
    toast('Замеры сохранены', 'success');
  } catch (err) {
    console.error('Замер не сохранён:', err);
    toast(err.message, 'error');
  } finally {
    restore();
  }
}

/* =========================================================
   15. ОТРИСОВКА
   ========================================================= */

function renderGreeting() {
  const now = new Date();
  const today = toISODate(now);
  $('current-date').textContent = formatLongDate(today);
  $('history-date').textContent = formatLongDate(today);
  $('greeting').textContent = greetingByHour(now.getHours());
}

/**
 * Дашборд калорий: линейная шкала с отметкой цели.
 *
 * Состояния:
 *  - empty    — ничего не съедено: шкала пустая, отметка цели в конце
 *  - progress — до 90% нормы: идём к цели, подпись «осталось N ккал»
 *  - near     — 90–100%: почти у цели, подпись «почти у цели»
 *  - reached  — ровно в норме или чуть выше (до +5%): цель взята
 *  - over     — больше +5%: перебор, шкала уходит за отметку
 *
 * Шкала показывает долю от нормы, но не выходит за 100% по ширине:
 * при переборе заливка доходит до конца, а подпись говорит про перебор.
 */
function renderCalories(totals) {
  const goal = Number(state.goals.kcal) || 0;
  const eaten = Number(totals.kcal) || 0;

  $('calorie-current').textContent = eaten;
  $('calorie-target').textContent = goal;
  $('dash-scale-goal').textContent = goal;

  const card = $('dash-card');
  const fill = $('dash-fill');
  const track = $('dash-track');
  const hint = $('calorie-left');

  if (!goal) {
    card.dataset.state = 'empty';
    fill.style.width = '0%';
    hint.textContent = 'Норма не рассчитана';
    track.setAttribute('aria-valuenow', '0');
    return;
  }

  const ratio = eaten / goal;
  const percent = Math.min(ratio * 100, 100);
  const left = goal - eaten;

  fill.style.width = `${percent.toFixed(1)}%`;
  track.setAttribute('aria-valuenow', String(Math.round(percent)));

  let stateName;
  let text;

  if (eaten === 0) {
    stateName = 'empty';
    text = `осталось ${goal} ккал`;
  } else if (ratio > 1.05) {
    stateName = 'over';
    text = `перебор на ${Math.abs(left)} ккал`;
  } else if (ratio >= 1) {
    stateName = 'reached';
    text = 'цель выполнена';
  } else if (ratio >= 0.9) {
    stateName = 'near';
    text = `почти у цели, осталось ${left} ккал`;
  } else {
    stateName = 'progress';
    text = `осталось ${left} ккал`;
  }

  card.dataset.state = stateName;
  hint.textContent = text;
}

function renderMacro(key, value) {
  const goal = state.goals[key];
  $(`${key}-consumed`).textContent = value;
  $(`${key}-goal`).textContent = goal;
  $(`${key}-bar`).style.width = `${percent(value, goal)}%`;
}

/** Лента приёмов пищи за сегодня */
function renderMeals(todayMeals) {
  const list = $('meal-list');
  list.replaceChildren();
  $('history-empty').classList.toggle('hidden', todayMeals.length > 0);

  // Новые записи сверху
  [...todayMeals].reverse().forEach((meal) => {
    const card = el('article', 'meal-card');

    const photo = el('div', 'meal-photo');
    if (meal.photo) {
      const img = el('img');
      img.src = meal.photo;
      img.alt = meal.title;
      img.loading = 'lazy';
      photo.appendChild(img);
    } else {
      photo.appendChild(el('div', 'meal-photo-placeholder', '🍽️'));
    }

    const info = el('div', 'meal-info');

    // Заголовок и карандаш в одну строку
    const head = el('div', 'meal-head');
    head.appendChild(el('h4', 'meal-name', meal.title));

    const edit = el('button', 'meal-edit');
    edit.type = 'button';
    edit.setAttribute('aria-label', `Редактировать: ${meal.title}`);
    edit.dataset.editId = String(meal.id);
    edit.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 20h9"></path>' +
      '<path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>';
    head.appendChild(edit);
    info.appendChild(head);

    // Время, вес еды и объём напитков
    const meta = [meal.time];
    if (meal.grams) meta.push(`${meal.grams} г`);
    if (meal.ml) meta.push(`${meal.ml} мл`);
    info.appendChild(el('time', 'meal-time', meta.join(' · ')));

    const macros = el('div', 'meal-macros');
    const parts = [
      `${meal.kcal} ккал`,
      `Б: ${meal.protein}г`,
      `Ж: ${meal.fats}г`,
      `У: ${meal.carbs}г`,
    ];
    parts.forEach((text, i) => {
      if (i > 0) macros.appendChild(el('span', '', '•'));
      macros.appendChild(el('span', '', text));
    });
    info.appendChild(macros);

    // Визуальный диагностический блок для проверки на смартфоне
    const debugAudit = el('div', 'meal-debug-audit');
    debugAudit.innerHTML = `
      <span class="debug-p">Белки: <strong>${meal.protein}</strong>г</span>
      <span class="debug-f">Жиры: <strong>${meal.fats}</strong>г</span>
      <span class="debug-c">Углеводы: <strong>${meal.carbs}</strong>г</span>
      <span class="debug-k">(${meal.kcal} ккал)</span>
    `;
    info.appendChild(debugAudit);

    // Состав: еда и напитки отдельными строками
    // Совет ИИ: показываем только если модель что-то написала
    const advice = typeof meal.ai_recommendation === 'string' ? meal.ai_recommendation.trim() : '';
    if (advice) {
      const tip = el('aside', 'meal-tip');
      tip.setAttribute('aria-label', 'Совет ИИ');
      tip.appendChild(el('span', 'meal-tip-label', 'Совет ИИ 💡'));
      tip.appendChild(el('p', 'meal-tip-text', advice));
      info.appendChild(tip);
    }

    const hasFood = meal.ingredients?.length;
    const hasDrinks = meal.drinks?.length;

    if (hasFood || hasDrinks) {
      const details = el('details', 'meal-details');
      details.appendChild(el('summary', 'meal-details-summary', 'Состав'));

      if (hasFood) {
        const line = el('p', 'meal-composition');
        line.textContent = 'Еда: ' + meal.ingredients.map((i) => `${i.name} ${i.grams} г`).join(' · ');
        details.appendChild(line);
      }

      if (hasDrinks) {
        const line = el('p', 'meal-composition');
        line.textContent =
          'Напитки: ' +
          meal.drinks.map((d) => `${d.name} ${d.ml ?? d.grams} мл`).join(' · ');
        details.appendChild(line);
      }

      info.appendChild(details);
    }

    card.append(photo, info);
    list.appendChild(card);
  });
}

function renderProgress() {
  const last = state.metrics[state.metrics.length - 1];

  const fields = [
    { key: 'weight', id: 'metric-weight', unit: 'кг' },
    { key: 'waist', id: 'metric-waist', unit: 'см' },
    { key: 'hips', id: 'metric-hips', unit: 'см' },
    { key: 'glutes', id: 'metric-glutes', unit: 'см' },
  ];

  fields.forEach(({ key, id, unit }) => {
    $(id).textContent = last ? `${last[key]} ${unit}` : '—';
    $(`${id}-date`).textContent = last ? `Обновлено ${formatShortDate(last.date)}` : 'Нет данных';
  });
}

/**
 * Шкала «Фактическое»: доли съеденных БЖУ в калориях.
 * Ширины секторов складываются в 100%, поэтому полоса всегда полная.
 */
function renderActualSplit(totals) {
  const pKcal = (totals.protein || 0) * 4;
  const fKcal = (totals.fats || 0) * 9;
  const cKcal = (totals.carbs || 0) * 4;
  const totalKcal = pKcal + fKcal + cKcal;

  const split = calorieSplit(totals.protein, totals.fats, totals.carbs);

  console.log("[Диагностика] Расчет шкалы 'Фактическое':", {
    "1. Граммы": { Б: totals.protein, Ж: totals.fats, У: totals.carbs },
    "2. В калориях (Б*4, Ж*9, У*4)": { Б_ккал: pKcal, Ж_ккал: fKcal, У_ккал: cKcal, Всего_ккал: totalKcal },
    "3. Итоговые проценты шкалы": {
      "Белки %": `${split.protein.toFixed(1)}%`,
      "Жиры %": `${split.fats.toFixed(1)}%`,
      "Углеводы %": `${split.carbs.toFixed(1)}%`
    }
  });

  const bar = $('split-actual-bar');
  const empty = split.protein + split.fats + split.carbs <= 0;

  bar.classList.toggle('is-empty', empty);
  MACRO_KEYS.forEach((key) => {
    $(`split-actual-${key}`).style.width = empty ? '0%' : `${split[key].toFixed(2)}%`;
  });

  $('split-actual-note').textContent = empty
    ? 'Пока нет данных о еде'
    : `Б ${Math.round(split.protein)}% · Ж ${Math.round(split.fats)}% · У ${Math.round(split.carbs)}%`;
}

/** Шкала «Целевое»: пропорции из настроек профиля */
function renderTargetSplit() {
  const split = state.goals.split || defaultSplitFor(state.profile?.goal || DEFAULT_GOAL);

  MACRO_KEYS.forEach((key) => {
    $(`split-target-${key}`).style.width = `${split[key]}%`;
  });

  $('split-target-note').textContent =
    `Б ${split.protein}% · Ж ${split.fats}% · У ${split.carbs}%`;
}

/**
 * Микронутриенты: клетчатка, натрий, сахар.
 * Если ни одна запись за день не содержит значение — показываем «нет данных»,
 * а не ноль: иначе пустая клетчатка выглядела бы как провал, а натрий — как идеал.
 */
function renderMicros(totals) {
  MICRO_KEYS.forEach((key) => {
    const meta = MICRO_META[key];
    const count = totals[`${key}Count`] || 0;
    const value = totals[key] || 0;

    const valueNode = $(`micro-${key}-value`);
    const barNode = $(`micro-${key}-bar`);

    $(`micro-${key}-goal`).textContent = `${meta.goal} ${meta.unit}`;

    if (!count) {
      valueNode.textContent = 'нет данных';
      valueNode.classList.add('is-empty');
      barNode.style.width = '0%';
      return;
    }

    valueNode.classList.remove('is-empty');
    valueNode.textContent = `${roundTo(value, meta.digits)} ${meta.unit}`;
    barNode.style.width = `${percent(value, meta.goal)}%`;

    // Перебор по натрию и сахару подсвечиваем — это ограничение, а не цель
    const isLimit = key === 'sodium' || key === 'sugar';
    barNode.classList.toggle('is-over', isLimit && value > meta.goal);
  });
}

function renderAll() {
  const today = toISODate();
  const todayMeals = state.meals.filter((m) => m.date === today);
  const totals = sumMeals(todayMeals);

  renderGreeting();
  renderCalories(totals);
  renderMacro('protein', totals.protein);
  renderMacro('fats', totals.fats);
  renderMacro('carbs', totals.carbs);
  renderMeals(todayMeals);
  renderActualSplit(totals);
  renderTargetSplit();
  renderMicros(totals);
  renderProgress();
}

/* =========================================================
   15б. НАСТРОЙКИ И СБРОС ДАННЫХ
   ========================================================= */

/** Показывает в настройках, задан ли ключ (сам ключ не раскрываем) */
function renderSettings() {
  const goal = state.profile?.goal || DEFAULT_GOAL;
  const meta = GOALS_META[goal] || GOALS_META[DEFAULT_GOAL];

  paintSegmented($('settings-goal'), goal);
  $('settings-goal-hint').textContent = `${meta.label}. ${meta.hint}`;

  renderSplitControls();
}

/**
 * Переключает цель, не теряя накопленные данные.
 *
 * Что происходит:
 *  1. Актуальный вес и объёмы берутся из последнего замера, а не из онбординга —
 *     за время похудения цифры изменились, и норма должна считаться по текущим.
 *  2. ИИ пересчитывает калории и БЖУ под новую цель.
 *  3. Обновляются ТОЛЬКО профиль и цели. Приёмы пищи и замеры не трогаются,
 *     поэтому история и графики остаются на месте.
 */
/**
 * Смена цели. Сервер пересчитывает норму калорий под текущий вес,
 * проценты БЖУ сбрасываются к пресету новой цели.
 */
async function changeGoal(nextGoal) {
  const meta = GOALS_META[nextGoal];
  if (!meta) return;
  if (state.profile?.goal === nextGoal) return;

  const container = $('settings-goal');
  const status = $('settings-goal-status');
  const buttons = [...container.querySelectorAll('.segmented-item')];

  buttons.forEach((btn) => {
    btn.disabled = true;
  });
  status.classList.remove('hidden');
  status.textContent = 'Пересчитываем норму…';

  // Актуальные параметры тела: последний замер важнее данных онбординга
  const last = state.metrics[state.metrics.length - 1];
  const profile = {
    ...state.profile,
    goal: nextGoal,
    currentWeight: last?.weight ?? state.profile?.currentWeight ?? 70,
    waist: last?.waist ?? state.profile?.waist ?? 0,
    hips: last?.hips ?? state.profile?.hips ?? 0,
    glutes: last?.glutes ?? state.profile?.glutes ?? 0,
  };

  let saved = null;
  try {
    saved = await saveProfileRemote(profile);
  } catch (err) {
    console.error('Пересчёт цели не удался:', err);
    toast(err.message, 'error');
    return;
  } finally {
    buttons.forEach((btn) => {
      btn.disabled = false;
    });
    status.classList.add('hidden');
  }

  state.profile = saved.profile;
  state.goals = normalizeGoalsShape(saved.goals, nextGoal);

  save(STORAGE_KEYS.profile, state.profile);
  save(STORAGE_KEYS.goals, state.goals);

  renderSettings();
  renderTargetSplit();
  renderAll();
  toast(`Цель: ${meta.label}`, 'success');
}

/**
 * Удаляет данные пользователя и возвращает приложение на онбординг.
 * keepKey = true оставляет ключ OpenRouter (частый случай при тестах).
 */
/**
 * Сброс данных.
 * keepKey оставлен для совместимости с прежними вызовами: ключа в браузере больше нет.
 * Данные удаляются и на сервере, иначе при следующем открытии они вернутся из Supabase.
 */
async function resetAllData() {
  const keys = [STORAGE_KEYS.profile, STORAGE_KEYS.goals, STORAGE_KEYS.metrics, STORAGE_KEYS.meals, STORAGE_KEYS.notes];
  keys.forEach((key) => localStorage.removeItem(key));

  try {
    await apiFetch('/api/data', { method: 'DELETE', body: {} });
  } catch (err) {
    console.warn('Серверные данные не удалены:', err.message);
    toast('Локальные данные удалены, серверные — нет: ' + err.message, 'error');
  }

  state.profile = null;
  state.goalDraft = DEFAULT_GOAL;
  state.goals = defaultGoalsFor(DEFAULT_GOAL);
  state.editingMealId = null;
  state.existingPhoto = '';
  state.metrics = [];
  state.meals = [];
  state.dayIndex = {};
  state.pendingPhoto = null;
  state.photoTask = null;

  closeAllModals();
  showOnboarding();
  renderAll();
  toast('Данные удалены', 'success');
}

/**
 * Подтверждение вторым нажатием: первое — предупреждение, второе — действие.
 * Состояние хранится в data-атрибуте кнопки, поэтому работает и для двух
 * кнопок сброса одновременно.
 */
function confirmTwice(button, question, onConfirm) {
  const original = button.textContent;

  const disarm = () => {
    clearTimeout(Number(button.dataset.timer));
    button.dataset.armed = '0';
    button.textContent = original;
    button.classList.remove('is-armed');
  };

  // Уже взведена — это второе нажатие, выполняем
  if (button.dataset.armed === '1') {
    disarm();
    onConfirm();
    return;
  }

  // Первое нажатие — только предупреждаем
  button.dataset.armed = '1';
  button.textContent = question;
  button.classList.add('is-armed');

  // Автосброс, если человек передумал и ничего не нажал
  button.dataset.timer = String(setTimeout(disarm, 6000));

  // Клик в любом другом месте снимает взвод.
  // Вешаем на следующем тике: иначе этот же клик сразу сработает как «снаружи».
  setTimeout(() => {
    const onOutside = (event) => {
      if (button.contains(event.target)) return; // клик по самой кнопке — не снаружи
      document.removeEventListener('click', onOutside, true);
      if (button.dataset.armed === '1') disarm();
    };
    document.addEventListener('click', onOutside, true);
  }, 0);
}

/**
 * Возвращает проценты БЖУ к пресету цели.
 * Калории не трогаем — они уже посчитаны под пользователя.
 */
/**
 * Возвращает проценты БЖУ к пресету цели.
 * Калории не трогаем — они посчитаны под пользователя.
 */
async function resetSplitToGoal() {
  const goal = state.profile?.goal || DEFAULT_GOAL;
  const kcal = Number(state.goals.kcal) || 0;

  state.goals = goalsFromSplit(kcal, defaultSplitFor(goal), 'goal');
  save(STORAGE_KEYS.goals, state.goals);

  renderSplitControls();
  renderTargetSplit();

  try {
    const data = await saveGoalsRemote(state.goals);
    state.goals = normalizeGoalsShape(data.goals, goal);
    save(STORAGE_KEYS.goals, state.goals);
  } catch (err) {
    console.warn('Сброс не сохранён на сервере:', err.message);
  }

  toast(`Проценты БЖУ сброшены к цели: ${GOALS_META[goal].label}`, 'success');
}

/* =========================================================
   ПОЛЗУНКИ БЖУ В НАСТРОЙКАХ
   ========================================================= */

/** Текущие проценты: из целей, иначе пресет цели */
function currentSplit() {
  return state.goals.split || defaultSplitFor(state.profile?.goal || DEFAULT_GOAL);
}

/** Выводит проценты и пересчитанные граммы для всех трёх ползунков */
function renderSplitControls() {
  const split = currentSplit();
  const kcal = Number(state.goals.kcal) || 0;

  $('split-kcal').textContent = kcal;

  MACRO_KEYS.forEach((key) => {
    const meta = MACRO_META[key];
    const input = $(`slider-${key}`);
    const grams = roundTo((kcal * split[key]) / 100 / meta.kcalPerGram, 0);

    input.value = split[key];
    $(`slider-${key}-value`).textContent = `${split[key]}%`;
    $(`slider-${key}-grams`).textContent = `${grams} г`;

    // Закрашенная часть дорожки — наглядно видно, сколько отдано макросу
    input.style.setProperty('--fill', `${split[key]}%`);
  });

  const sum = MACRO_KEYS.reduce((acc, key) => acc + split[key], 0);
  $('split-sum').textContent = `${sum}%`;
  $('split-sum').classList.toggle('is-bad', sum !== 100);

  // Откуда взялись проценты: из цели или настроены вручную
  const manual = state.goals.splitSource === 'manual';
  const goalLabel = GOALS_META[state.profile?.goal]?.label || 'цели';

  const sourceNode = $('split-source');
  sourceNode.textContent = manual
    ? 'Настроено вручную'
    : `По цели: ${goalLabel}`;
  sourceNode.classList.toggle('is-manual', manual);

  // Кнопка сброса нужна только когда раскладка ручная
  $('btn-split-reset').classList.toggle('hidden', !manual);
}

/**
 * Двигает один ползунок: оставшиеся проценты делятся между двумя другими
 * пропорционально их текущим значениям. Сумма всегда ровно 100.
 */
/**
 * Двигает один ползунок: оставшиеся проценты делятся между двумя другими
 * пропорционально их текущим значениям. Сумма всегда ровно 100.
 * Раскладка сохраняется на сервере, чтобы она была доступна боту и другим устройствам.
 */
let splitSaveTimer = null;

function handleSliderInput(key, value) {
  const nextSplit = distributeSplit(key, value, currentSplit());
  const kcal = Number(state.goals.kcal) || 0;

  state.goals = goalsFromSplit(kcal, nextSplit, 'manual');
  save(STORAGE_KEYS.goals, state.goals);

  renderSplitControls();
  renderTargetSplit();

  // Сохраняем не на каждое движение пальцем, а через паузу
  clearTimeout(splitSaveTimer);
  splitSaveTimer = setTimeout(async () => {
    try {
      const data = await saveGoalsRemote(state.goals);
      state.goals = normalizeGoalsShape(data.goals, state.profile?.goal);
      save(STORAGE_KEYS.goals, state.goals);
    } catch (err) {
      console.warn('Раскладка БЖУ не сохранена на сервере:', err.message);
    }
  }, 600);
}

function initSplitSliders() {
  MACRO_KEYS.forEach((key) => {
    const input = $(`slider-${key}`);
    input.addEventListener('input', () => {
      handleSliderInput(key, input.value);
    });
  });

  $('btn-split-reset').addEventListener('click', resetSplitToGoal);
}

function initSettings() {
  $('btn-settings').addEventListener('click', () => {
    renderSettings();
    openModal($('modal-settings'));
  });

  // Переключение цели без потери прогресса
  $('settings-goal').addEventListener('click', (event) => {
    const btn = event.target.closest('.segmented-item');
    if (!btn || btn.disabled) return;
    changeGoal(btn.dataset.goal);
  });

  $('btn-reset-data').addEventListener('click', (event) => {
    confirmTwice(event.currentTarget, 'Точно удалить данные?', () => {
      resetAllData();
    });
  });
}

/* =========================================================
   16. ИНИЦИАЛИЗАЦИЯ
   ========================================================= */

function init() {
  loadStateFromCache();
  initTabs();
  initOnboarding();
  initModals();
  initSettings();

  $('form-meal').addEventListener('submit', handleMealSubmit);
  $('meal-photo').addEventListener('change', handlePhotoChange);
  $('form-metrics').addEventListener('submit', handleMetricsSubmit);

  initSplitSliders();

  $('btn-add-ingredient').addEventListener('click', () => addIngredientRow('', '', true));
  $('btn-add-drink').addEventListener('click', () => addDrinkRow('', '', true));

  resetIngredients();
  renderAll();

  // Сеть подключаем после отрисовки: интерфейс не ждёт сервер
  syncFromServer();
}

// Запускаем сразу, если DOM уже разобран, иначе ждём DOMContentLoaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
