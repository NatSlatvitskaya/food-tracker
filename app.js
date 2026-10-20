/* =========================================================
   app.js — трекер питания с ИИ (OpenRouter)
   Все данные лежат в localStorage. Без сборки и зависимостей.
   ========================================================= */

'use strict';

/* =========================================================
   1. КОНФИГУРАЦИЯ
   ========================================================= */

// Полный адрес эндпоинта. Просто https://openrouter.ai не отвечает на POST —
// нужен путь /api/v1/chat/completions
const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const API_TIMEOUT_MS = 45000;

/*
  МОДЕЛИ. Проверяются по порядку: если первая недоступна (модель снята
  с продажи, нет доступа), запрос повторяется со следующей.

  google/gemini-flash-1.5 больше не существует в каталоге OpenRouter —
  Google снял линейку 1.5. Актуальный список: openrouter.ai/models
  Условие для модели: поддержка изображений (input_modalities: image).
*/
const API_MODELS = [
  'google/gemini-2.5-flash',        // основная: быстрая, дешёвая, видит фото
  'google/gemini-2.5-flash-lite',   // легче и дешевле
  'google/gemma-4-31b-it:free',     // бесплатный резерв
];

// Ключ НЕ хранится в коде: он вводится один раз и лежит в localStorage
const API_KEY_STORAGE = 'tracker.apiKey';

// Ключи localStorage для данных
const STORAGE_KEYS = {
  profile: 'tracker.profile',
  goals: 'tracker.goals',
  metrics: 'tracker.metrics',
  meals: 'tracker.meals',
};

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
      'Распределение калорий: белки 25%, жиры 30%, углеводы 45%.',
  },
  maintain: {
    label: 'Поддержание формы',
    defaults: { kcal: 2000, protein: 100, fats: 67, carbs: 250 },
    hint: 'Баланс трат и потребления, без дефицита и профицита',
    instruction:
      'Цель — удержание веса. Норма равна суточным тратам, без дефицита и профицита. ' +
      'Распределение калорий: белки 20%, жиры 30%, углеводы 50%.',
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
function defaultGoalsFor(goal) {
  const meta = GOALS_META[goal] || GOALS_META[DEFAULT_GOAL];
  return { ...meta.defaults };
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
  return meals.reduce(
    (acc, m) => ({
      kcal: acc.kcal + m.kcal,
      protein: acc.protein + m.protein,
      fats: acc.fats + m.fats,
      carbs: acc.carbs + m.carbs,
    }),
    { kcal: 0, protein: 0, fats: 0, carbs: 0 }
  );
}

/** Округление до целого, безопасное для строк и undefined */
function round(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

/* =========================================================
   3. JSON ОТ МОДЕЛИ
   ========================================================= */

/**
 * Модели любят оборачивать JSON в ```json ... ``` и добавлять текст вокруг.
 * Достаём первый объект {...} и парсим его.
 */
function parseModelJson(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error('Модель вернула пустой ответ');
  }

  const cleaned = raw
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('В ответе модели нет JSON');
  }

  return JSON.parse(cleaned.slice(start, end + 1));
}

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
};

function loadState() {
  state.profile = load(STORAGE_KEYS.profile, null);
  state.goalDraft = state.profile?.goal || DEFAULT_GOAL;
  state.goals = load(STORAGE_KEYS.goals, defaultGoalsFor(state.goalDraft));
  state.metrics = load(STORAGE_KEYS.metrics, []);
  state.meals = load(STORAGE_KEYS.meals, []);
}

/** Замер за сегодня заменяет предыдущий, иначе добавляется новый */
function upsertMetric(entry) {
  const last = state.metrics[state.metrics.length - 1];
  if (last && last.date === entry.date) {
    state.metrics[state.metrics.length - 1] = entry;
  } else {
    state.metrics.push(entry);
  }
  save(STORAGE_KEYS.metrics, state.metrics);
}

/* =========================================================
   5. КЛЮЧ API
   ========================================================= */

function getApiKey() {
  return localStorage.getItem(API_KEY_STORAGE) || '';
}

/**
 * Просит пользователя вставить ключ OpenRouter.
 * Окно создаётся прямо в JS, поэтому index.html менять не нужно.
 * Возвращает Promise с ключом (или null, если пользователь закрыл окно).
 */
function askForApiKey() {
  return new Promise((resolve) => {
    const modal = el('div', 'modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const backdrop = el('div', 'modal-backdrop');
    const content = el('div', 'modal-content');
    const header = el('header', 'modal-header');
    const title = el('h3', '', 'Ключ OpenRouter');
    const closeBtn = el('button', 'modal-close', '×');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Закрыть');
    header.append(title, closeBtn);

    const form = el('form', 'modal-form');

    const hint = el(
      'p',
      'form-hint',
      'Ключ хранится только в этом браузере (localStorage) и не попадает в код сайта. Получить ключ: openrouter.ai/keys'
    );

    const group = el('div', 'form-group');
    const label = el('label', '', 'Ключ API');
    label.setAttribute('for', 'api-key-input');
    const input = el('input');
    input.type = 'password';
    input.id = 'api-key-input';
    input.placeholder = 'sk-or-v1-...';
    input.autocomplete = 'off';
    group.append(label, input);

    const submit = el('button', 'btn-primary', 'Сохранить ключ');
    submit.type = 'submit';

    form.append(hint, group, submit);
    content.append(header, form);
    modal.append(backdrop, content);
    document.body.appendChild(modal);

    // Небольшая задержка, чтобы сработала анимация появления
    requestAnimationFrame(() => modal.classList.add('open'));

    function finish(value) {
      modal.classList.remove('open');
      setTimeout(() => modal.remove(), 250);
      resolve(value);
    }

    closeBtn.addEventListener('click', () => finish(null));
    backdrop.addEventListener('click', () => finish(null));

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const key = input.value.trim();
      if (!key) {
        input.focus();
        return;
      }
      localStorage.setItem(API_KEY_STORAGE, key);
      finish(key);
    });

    setTimeout(() => input.focus(), 100);
  });
}

/** Возвращает существующий ключ или просит ввести новый */
async function ensureApiKey() {
  const existing = getApiKey();
  if (existing) return existing;
  return askForApiKey();
}

/* =========================================================
   6. ЗАПРОСЫ К OPENROUTER
   ========================================================= */

/**
 * Отправляет сообщения в модель и возвращает текст ответа.
 * content — либо строка, либо массив частей (для фото).
 */
/**
 * Отправляет один запрос к указанной модели.
 * Возвращает { text } при успехе или бросает ошибку с полем .status.
 */
async function requestModel(model, apiKey, content, maxTokens) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // Необязательные заголовки для статистики OpenRouter
        'HTTP-Referer': location.origin,
        'X-Title': 'Food Tracker',
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content }],
      }),
    });
  } catch (err) {
    clearTimeout(timer);

    if (err.name === 'AbortError') {
      const timeout = new Error('Модель не ответила за 45 секунд. Попробуйте ещё раз');
      timeout.status = 'timeout';
      throw timeout;
    }

    // fetch отдаёт TypeError, когда запрос не дошёл или ответ заблокирован CORS
    const network = new Error(
      'Запрос не дошёл до OpenRouter. Проверьте интернет и VPN — ' +
        'некоторые блокировщики рекламы режут запросы к openrouter.ai'
    );
    network.status = 'network';
    throw network;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let details = '';
    try {
      const data = await response.json();
      details = data?.error?.message || '';
    } catch (_) {
      /* тело не JSON — оставляем пустым */
    }

    const error = new Error(details || `HTTP ${response.status}`);
    error.status = response.status;
    error.model = model;
    throw error;
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) {
    const empty = new Error('Модель вернула пустой ответ');
    empty.status = 'empty';
    throw empty;
  }
  return text;
}

/**
 * Пробует модели по очереди. Переключается на следующую, только если
 * проблема в самой модели (404) или недоступности провайдера (5xx).
 * Ошибки ключа и баланса не повторяем — они не зависят от модели.
 */
async function callModel(content, maxTokens = 500) {
  const apiKey = await ensureApiKey();
  if (!apiKey) {
    throw new Error('Нужен ключ OpenRouter');
  }

  let lastError = null;

  for (const model of API_MODELS) {
    try {
      return await requestModel(model, apiKey, content, maxTokens);
    } catch (err) {
      lastError = err;

      if (err.status === 401) {
        throw new Error('Ключ отклонён. Проверьте, что скопировали его целиком, и войдите в аккаунт OpenRouter');
      }
      if (err.status === 402) {
        throw new Error('На балансе OpenRouter закончились средства');
      }
      if (err.status === 429) {
        throw new Error('Слишком много запросов. Подождите минуту и повторите');
      }

      // 404 — модель снята с продажи, пробуем следующую
      // 5xx — сбой у провайдера, тоже имеет смысл повторить с другой моделью
      const retryable = err.status === 404 || (typeof err.status === 'number' && err.status >= 500);
      if (!retryable) throw err;

      console.warn(`Модель ${model} недоступна (${err.status}), пробую следующую`);
    }
  }

  throw new Error(
    `Ни одна модель не ответила. Последняя ошибка: ${lastError?.message || 'неизвестно'}. ` +
      'Актуальные модели: openrouter.ai/models'
  );
}

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

/** Промпт для расчёта целей: текст зависит от выбранной цели по весу */
function buildGoalsPrompt(profile) {
  const meta = GOALS_META[profile.goal] || GOALS_META[DEFAULT_GOAL];

  return [
    `Пользователь: возраст ${profile.age}, вес ${profile.currentWeight} кг,`,
    `замеры талия/бёдра/ягодицы ${profile.waist}/${profile.hips}/${profile.glutes} см,`,
    `желаемый вес ${profile.targetWeight} кг.`,
    `Главная цель: ${meta.label}.`,
    meta.instruction,
    'Рассчитай суточную норму калорий по формуле Миффлина-Сан Жеора.',
    'Переведи проценты в граммы: белки и углеводы — 4 ккал на грамм, жиры — 9 ккал на грамм.',
    'Верни ответ СТРОГО в формате JSON без markdown и без лишних слов:',
    '{"calories": 1750, "protein": 100, "fat": 58, "carbs": 206}',
  ].join(' ');
}

/** Приводит ответ модели к внутреннему виду целей */
function normalizeGoals(data) {
  const goals = {
    kcal: round(data.calories),
    protein: round(data.protein),
    fats: round(data.fat ?? data.fats),
    carbs: round(data.carbs),
  };

  // Грубая проверка на вменяемость: иначе модель может вернуть нули
  const valid =
    goals.kcal >= 800 && goals.kcal <= 6000 &&
    goals.protein > 0 && goals.fats > 0 && goals.carbs > 0;

  return valid ? goals : null;
}

/**
 * Кнопка "Рассчитать цель через ИИ-агента".
 * ВРЕМЕННАЯ ЧАСТЬ: при ошибке сети цели остаются дефолтными,
 * чтобы пользователь не оказался заперт на стартовом экране.
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
    createdAt: toISODate(),
  };

  const restore = setButtonLoading(button, 'ИИ анализирует…');
  setFormError(form, '');

  let goals = null;
  try {
    const raw = await callModel(buildGoalsPrompt(profile), 300);
    goals = normalizeGoals(parseModelJson(raw));
    if (!goals) throw new Error('Модель вернула некорректные значения');
  } catch (err) {
    console.error('Расчёт целей не удался:', err);
    const fallback = defaultGoalsFor(profile.goal);
    setFormError(form, `${err.message}. Применены цели по умолчанию ${fallback.kcal} ккал.`);
    goals = fallback;
  } finally {
    restore();
  }

  state.profile = profile;
  state.goals = goals;

  // Данные онбординга становятся первым замером в истории прогресса
  upsertMetric({
    date: profile.createdAt,
    weight: profile.currentWeight,
    waist: profile.waist,
    hips: profile.hips,
    glutes: profile.glutes,
  });

  save(STORAGE_KEYS.profile, profile);
  save(STORAGE_KEYS.goals, goals);

  hideOnboarding();
  renderAll();
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

/**
 * Промпт для распознавания приёма пищи.
 * Еда идёт в граммах, напитки — в миллилитрах: модель должна знать,
 * что 250 мл латте и 250 г латте — не одно и то же.
 */
function buildMealPrompt(ingredients, drinks, title, hasPhoto) {
  const lines = [];

  lines.push(
    hasPhoto
      ? 'Проанализируй фото этого приёма пищи и указанный состав.'
      : 'Проанализируй состав приёма пищи.'
  );

  if (title) lines.push(`Блюдо: ${title}.`);

  if (ingredients.length) {
    const list = ingredients.map((i) => `${i.name} — ${i.grams} г`).join(', ');
    lines.push(`Еда (вес в граммах): ${list}. Общий вес еды: ${totalGrams(ingredients)} г.`);
  }

  if (drinks.length) {
    const list = drinks.map((d) => `${d.name} — ${d.ml} мл`).join(', ');
    lines.push(
      `Напитки (объём в миллилитрах): ${list}. Общий объём: ${totalMl(drinks)} мл.`
    );
    lines.push(
      'Для напитков пересчитывай объём в вес по плотности (вода и кофе ≈ 1 г/мл, ' +
        'молоко ≈ 1.03 г/мл, сок ≈ 1.05 г/мл) и учитывай калорийность по составу.'
    );
  }

  lines.push('Рассчитай КБЖУ всего приёма пищи — еды и напитков вместе.');
  lines.push('Верни ответ СТРОГО в формате JSON без markdown:');
  lines.push(
    '{"title": "Название на русском", "calories": 420, "protein": 25, "fat": 12, "carbs": 53}'
  );

  return lines.join(' ');
}

/** Собирает мультимодальный контент: текст состава + фото, если есть */
function buildMealContent(ingredients, drinks, title, photoDataUrl) {
  const parts = [
    { type: 'text', text: buildMealPrompt(ingredients, drinks, title, Boolean(photoDataUrl)) },
  ];
  if (photoDataUrl) {
    parts.push({ type: 'image_url', image_url: { url: photoDataUrl } });
  }
  return parts;
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
function normalizeMeal(data) {
  const meal = {
    title: String(data.title || 'Приём пищи').slice(0, 80),
    kcal: round(data.calories),
    protein: round(data.protein),
    fats: round(data.fat ?? data.fats),
    carbs: round(data.carbs),
  };

  const valid = meal.kcal > 0 && meal.kcal < 5000;
  return valid ? meal : null;
}

async function handleMealSubmit(event) {
  event.preventDefault();

  const form = event.target;
  const button = form.querySelector('button[type="submit"]');

  setFormError(form, '');

  const ingredients = readIngredients();
  const drinks = readDrinks();

  if (!ingredients.length && !drinks.length) {
    setFormError(form, 'Добавьте хотя бы один продукт или напиток с названием и количеством.');
    return;
  }

  const nameInput = $('meal-name').value.trim();
  const restore = setButtonLoading(button, 'ИИ анализирует…');

  try {
    // Если фото ещё обрабатывается — дождёмся, иначе уйдёт запрос без картинки
    if (state.photoTask) await state.photoTask;

    const content = buildMealContent(ingredients, drinks, nameInput, state.pendingPhoto?.dataUrl);
    const raw = await callModel(content, 400);
    const analyzed = normalizeMeal(parseModelJson(raw));

    if (!analyzed) throw new Error('Не удалось распознать приём пищи');

    const now = new Date();
    const time = now.toTimeString().slice(0, 5);
    const record = {
      date: toISODate(now),
      time,
      category: mealCategoryFor(time),
      title: nameInput || analyzed.title,
      ingredients,
      drinks,
      grams: totalGrams(ingredients),
      ml: totalMl(drinks),
      kcal: analyzed.kcal,
      protein: analyzed.protein,
      fats: analyzed.fats,
      carbs: analyzed.carbs,
      photo: state.pendingPhoto?.thumb || state.existingPhoto || '',
    };

    if (state.editingMealId !== null) {
      // Режим правки: перезаписываем существующую запись, время и дату сохраняем
      const index = state.meals.findIndex((m) => m.id === state.editingMealId);
      if (index >= 0) {
        record.id = state.meals[index].id;
        record.date = state.meals[index].date;
        record.time = state.meals[index].time;
        // Категорию не пересчитываем: правка состава не должна
        // переносить утренний завтрак в ужин
        record.category = state.meals[index].category || record.category;
        state.meals[index] = record;
      } else {
        record.id = Date.now();
        state.meals.push(record);
      }
    } else {
      record.id = Date.now();
      state.meals.push(record);
    }

    if (!save(STORAGE_KEYS.meals, state.meals)) {
      // Квота закончилась: убираем фото у этой записи и пробуем снова
      const target = state.meals.find((m) => m.id === record.id);
      if (target) target.photo = '';
      save(STORAGE_KEYS.meals, state.meals);
    }

    const wasEditing = state.editingMealId !== null;
    closeModal($('modal-add-meal'));
    renderAll();
    toast(
      wasEditing ? `Обновлено: ${analyzed.kcal} ккал` : `${analyzed.kcal} ккал · записано`,
      'success'
    );
  } catch (err) {
    console.error('Распознавание не удалось:', err);
    setFormError(form, err.message);
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

function handleMetricsSubmit(event) {
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

  upsertMetric(entry);
  closeModal($('modal-add-metrics'));
  renderAll();
  toast('Замеры сохранены', 'success');
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

function renderCalories(totals) {
  const goal = state.goals.kcal;
  const ratio = goal ? Math.min(totals.kcal / goal, 1) : 0;

  $('calorie-current').textContent = totals.kcal;
  $('calorie-target').textContent = goal;

  const ring = $('ring-fill');
  ring.style.strokeDasharray = RING_LENGTH;
  ring.style.strokeDashoffset = RING_LENGTH * (1 - ratio);
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

    // Состав: еда и напитки отдельными строками
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
 * Суммирует калории по категориям и рисует кольцо с легендой.
 *
 * Кольцо — один div с conic-gradient: сектора задаются CSS-переменной
 * --donut-segments строкой вида "#34c759 0% 25%, #ff9f0a 25% 60%".
 * Это дешевле SVG и не требует пересоздания DOM при каждом обновлении.
 */
function renderMealSplit(todayMeals) {
  const byCategory = {};
  MEAL_CATEGORIES.forEach((c) => {
    byCategory[c.key] = { kcal: 0 };
  });

  todayMeals.forEach((meal) => {
    // У старых записей поля category нет — определяем по времени
    const key = meal.category || mealCategoryFor(meal.time);
    const bucket = byCategory[key] || byCategory.snack;
    bucket.kcal += meal.kcal;
  });

  const total = MEAL_CATEGORIES.reduce((sum, c) => sum + byCategory[c.key].kcal, 0);

  $('donut-total').textContent = total;
  $('donut-empty').classList.toggle('hidden', total > 0);

  const donut = $('donut');
  const legend = $('donut-legend');
  legend.replaceChildren();

  // Пусто за день: серое кольцо, легенды нет
  if (!total) {
    donut.style.setProperty('--donut-segments', '#e5e5ea');
    donut.setAttribute('aria-label', 'За сегодня калорий нет');
    return;
  }

  // Сектора: проценты накапливаем, чтобы на стыках не было щелей
  const stops = [];
  let cursor = 0;

  MEAL_CATEGORIES.forEach((cat) => {
    const kcal = byCategory[cat.key].kcal;
    if (!kcal) return;
    const start = cursor;
    cursor += (kcal / total) * 100;
    stops.push(`${cat.color} ${start.toFixed(2)}% ${cursor.toFixed(2)}%`);
  });

  // Округление может оставить зазор до 100% — дотягиваем последний сектор
  if (stops.length) {
    stops[stops.length - 1] = stops[stops.length - 1].replace(/[\d.]+%$/, '100%');
  }

  donut.style.setProperty('--donut-segments', stops.join(', '));

  const parts = MEAL_CATEGORIES.filter((c) => byCategory[c.key].kcal).map(
    (c) => `${c.label} ${Math.round((byCategory[c.key].kcal / total) * 100)}%`
  );
  donut.setAttribute('aria-label', `Распределение: ${parts.join(', ')}`);

  // Легенда: все четыре категории, пустые приглушены
  MEAL_CATEGORIES.forEach((cat) => {
    const kcal = byCategory[cat.key].kcal;
    const share = Math.round((kcal / total) * 100);

    const item = el('li', kcal ? '' : 'is-empty');

    const dot = el('span', 'donut-dot');
    dot.style.backgroundColor = cat.color;

    item.append(
      dot,
      el('span', 'donut-legend-label', `${cat.icon} ${cat.label}`),
      el('span', 'donut-legend-percent', `${share}%`)
    );

    legend.appendChild(item);
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
  renderMealSplit(todayMeals);
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

  const key = getApiKey();
  const node = $('settings-key');
  if (!key) {
    node.textContent = 'не задан';
    node.classList.remove('is-set');
    return;
  }
  // Показываем только начало и конец — так видно, что ключ тот самый,
  // но целиком он не светится на случай, если кто-то смотрит на экран
  node.textContent = `${key.slice(0, 8)}…${key.slice(-4)}`;
  node.classList.add('is-set');
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
async function changeGoal(nextGoal) {
  const meta = GOALS_META[nextGoal];
  if (!meta) return;
  if (state.profile?.goal === nextGoal) return; // уже выбрана

  const container = $('settings-goal');
  const status = $('settings-goal-status');
  const buttons = [...container.querySelectorAll('.segmented-item')];

  // Блокируем переключатель на время запроса
  buttons.forEach((btn) => {
    btn.disabled = true;
  });
  status.classList.remove('hidden');
  status.textContent = 'ИИ пересчитывает норму…';

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

  let goals = null;
  let failed = false;

  try {
    const raw = await callModel(buildGoalsPrompt(profile), 300);
    goals = normalizeGoals(parseModelJson(raw));
    if (!goals) throw new Error('Модель вернула некорректные значения');
  } catch (err) {
    console.error('Пересчёт цели не удался:', err);
    goals = defaultGoalsFor(nextGoal);
    failed = true;
  } finally {
    buttons.forEach((btn) => {
      btn.disabled = false;
    });
    status.classList.add('hidden');
  }

  // Сохраняем только профиль и цели — история остаётся нетронутой
  state.profile = profile;
  state.goals = goals;
  save(STORAGE_KEYS.profile, profile);
  save(STORAGE_KEYS.goals, goals);

  renderSettings();
  renderAll();

  if (failed) {
    toast(`Цель: ${meta.label}. Применены значения по умолчанию ${goals.kcal} ккал`, 'info');
  } else {
    toast(`Цель: ${meta.label}. Норма ${goals.kcal} ккал`, 'success');
  }
}

/**
 * Удаляет данные пользователя и возвращает приложение на онбординг.
 * keepKey = true оставляет ключ OpenRouter (частый случай при тестах).
 */
function resetAllData({ keepKey = true } = {}) {
  const keys = [STORAGE_KEYS.profile, STORAGE_KEYS.goals, STORAGE_KEYS.metrics, STORAGE_KEYS.meals];
  keys.forEach((key) => localStorage.removeItem(key));
  if (!keepKey) localStorage.removeItem(API_KEY_STORAGE);

  // Сбрасываем состояние в памяти, иначе старые данные останутся в интерфейсе
  state.profile = null;
  state.goalDraft = DEFAULT_GOAL;
  state.goals = defaultGoalsFor(DEFAULT_GOAL);
  state.editingMealId = null;
  state.existingPhoto = '';
  state.metrics = [];
  state.meals = [];
  state.pendingPhoto = null;
  state.photoTask = null;

  closeAllModals();
  showOnboarding();
  renderAll();
  toast(keepKey ? 'Данные сброшены, ключ сохранён' : 'Всё удалено, включая ключ', 'success');
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

function initSettings() {
  $('btn-settings').addEventListener('click', () => {
    renderSettings();
    openModal($('modal-settings'));
  });

  // Замена ключа: удаляем старый и открываем окно ввода заново
  $('btn-change-key').addEventListener('click', async () => {
    localStorage.removeItem(API_KEY_STORAGE);
    closeModal($('modal-settings'));

    const key = await askForApiKey();
    if (key) {
      toast('Ключ обновлён', 'success');
      renderSettings();
    }
  });

  // Переключение цели без потери прогресса
  $('settings-goal').addEventListener('click', (event) => {
    const btn = event.target.closest('.segmented-item');
    if (!btn || btn.disabled) return;
    changeGoal(btn.dataset.goal);
  });

  $('btn-reset-data').addEventListener('click', (event) => {
    confirmTwice(event.currentTarget, 'Точно удалить данные?', () => {
      resetAllData({ keepKey: true });
    });
  });

  $('btn-reset-all').addEventListener('click', (event) => {
    confirmTwice(event.currentTarget, 'Точно всё удалить?', () => {
      resetAllData({ keepKey: false });
    });
  });
}

/* =========================================================
   16. ИНИЦИАЛИЗАЦИЯ
   ========================================================= */

function init() {
  loadState();
  initTabs();
  initOnboarding();
  initModals();
  initSettings();

  $('form-meal').addEventListener('submit', handleMealSubmit);
  $('meal-photo').addEventListener('change', handlePhotoChange);
  $('form-metrics').addEventListener('submit', handleMetricsSubmit);

  $('btn-add-ingredient').addEventListener('click', () => addIngredientRow('', '', true));
  $('btn-add-drink').addEventListener('click', () => addDrinkRow('', '', true));

  resetIngredients();
  renderAll();
}

// Запускаем сразу, если DOM уже разобран, иначе ждём DOMContentLoaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
