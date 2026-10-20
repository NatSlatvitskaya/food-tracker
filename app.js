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

// Резервные цели, если ИИ недоступен
const DEFAULT_GOALS = { kcal: 1800, protein: 90, fats: 60, carbs: 180 };

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
  goals: { ...DEFAULT_GOALS },
  metrics: [],
  meals: [],
  pendingPhoto: null, // { name, dataUrl } выбранного фото
  photoTask: null,    // Promise обработки фото (чтобы дождаться его перед отправкой)
};

function loadState() {
  state.profile = load(STORAGE_KEYS.profile, null);
  state.goals = load(STORAGE_KEYS.goals, { ...DEFAULT_GOALS });
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
}

/** Промпт для расчёта целей */
function buildGoalsPrompt(profile) {
  return [
    `Пользователь: возраст ${profile.age}, вес ${profile.currentWeight},`,
    `замеры ${profile.waist}/${profile.hips}/${profile.glutes},`,
    `цель по весу ${profile.targetWeight}.`,
    'Рассчитай суточную норму калорий по формуле Миффлина-Сан Жеора',
    'с безопасным дефицитом 15-20% для плавного похудения. Распредели БЖУ.',
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
    setFormError(form, `${err.message}. Применены цели по умолчанию 1800 ккал.`);
    goals = { ...DEFAULT_GOALS };
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
  $('btn-add-meal').addEventListener('click', () => {
    resetMealForm();
    openModal($('modal-add-meal'));
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
 * Промпт для распознавания блюда.
 * Перечисляем каждый ингредиент с весом — модель считает точнее,
 * чем по одному общему весу, потому что видит структуру блюда.
 */
function buildMealPrompt(ingredients, title, hasPhoto) {
  const list = ingredients.map((i) => `${i.name} — ${i.grams} г`).join(', ');
  const total = totalGrams(ingredients);

  const lines = [
    hasPhoto ? 'Проанализируй фото этого блюда и указанный состав.' : 'Проанализируй состав блюда.',
    `Блюдо: ${title || 'без названия'}.`,
    `Состав и вес продуктов: ${list}.`,
    `Общий вес блюда: ${total} г.`,
    'Рассчитай КБЖУ всего блюда на основе состава и веса каждого продукта.',
    'Верни ответ СТРОГО в формате JSON без markdown:',
    '{"title": "Название блюда на русском", "calories": 420, "protein": 25, "fat": 12, "carbs": 53}',
  ];
  return lines.join(' ');
}

/** Собирает мультимодальный контент: текст состава + фото, если есть */
function buildMealContent(ingredients, title, photoDataUrl) {
  const parts = [
    { type: 'text', text: buildMealPrompt(ingredients, title, Boolean(photoDataUrl)) },
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

/** Читает строки ингредиентов из DOM. Пустые строки пропускает */
function readIngredients() {
  return [...$('ingredients').querySelectorAll('.ingredient-row')]
    .map((row) => ({
      name: row.querySelector('.ingredient-name').value.trim(),
      grams: Number(row.querySelector('.ingredient-grams').value),
    }))
    .filter((i) => i.name && i.grams > 0);
}

/** Пересчитывает подпись «Итого: N г» */
function updateIngredientsTotal() {
  const total = totalGrams(readIngredients());
  $('ingredients-total').textContent = `Итого: ${total} г`;
}

/**
 * Добавляет строку ингредиента.
 * Удаление доступно, только если строк больше одной —
 * иначе форма останется пустой без возможности ввода.
 */
function addIngredientRow(name = '', grams = '') {
  const row = el('div', 'ingredient-row');

  const nameInput = el('input', 'ingredient-name');
  nameInput.type = 'text';
  nameInput.placeholder = 'Продукт';
  nameInput.value = name;
  nameInput.autocomplete = 'off';

  const gramsInput = el('input', 'ingredient-grams');
  gramsInput.type = 'number';
  gramsInput.inputMode = 'numeric';
  gramsInput.min = '1';
  gramsInput.placeholder = 'г';
  gramsInput.value = grams;

  const remove = el('button', 'ingredient-remove', '×');
  remove.type = 'button';
  remove.setAttribute('aria-label', 'Удалить ингредиент');

  const sync = () => {
    updateIngredientsTotal();
    const rows = $('ingredients').querySelectorAll('.ingredient-row');
    const onlyOne = rows.length <= 1;
    $('ingredients').querySelectorAll('.ingredient-remove').forEach((btn) => {
      btn.disabled = onlyOne;
    });
  };

  nameInput.addEventListener('input', sync);
  gramsInput.addEventListener('input', sync);

  remove.addEventListener('click', () => {
    if ($('ingredients').querySelectorAll('.ingredient-row').length <= 1) return;
    row.remove();
    sync();

    // Фокус на следующую разумную строку — чтобы не терять контекст
    const next = $('ingredients').querySelector('.ingredient-name:last-of-type');
    if (next) next.focus();
  });

  // Enter в поле веса добавляет новую строку — удобно на телефоне
  gramsInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addIngredientRow();
    const inputs = $('ingredients').querySelectorAll('.ingredient-name');
    inputs[inputs.length - 1].focus();
  });

  row.append(nameInput, gramsInput, remove);
  $('ingredients').appendChild(row);
  sync();
}

/** Очищает состав и оставляет одну пустую строку */
function resetIngredients() {
  $('ingredients').replaceChildren();
  addIngredientRow();
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
  if (!ingredients.length) {
    setFormError(form, 'Добавьте хотя бы один ингредиент с названием и весом.');
    return;
  }

  const nameInput = $('meal-name').value.trim();
  const restore = setButtonLoading(button, 'ИИ анализирует…');

  try {
    // Если фото ещё обрабатывается — дождёмся, иначе уйдёт запрос без картинки
    if (state.photoTask) await state.photoTask;

    const content = buildMealContent(ingredients, nameInput, state.pendingPhoto?.dataUrl);
    const raw = await callModel(content, 400);
    const analyzed = normalizeMeal(parseModelJson(raw));

    if (!analyzed) throw new Error('Не удалось распознать блюдо');

    const now = new Date();
    state.meals.push({
      id: Date.now(),
      date: toISODate(now),
      time: now.toTimeString().slice(0, 5),
      title: nameInput || analyzed.title,
      ingredients,
      grams: totalGrams(ingredients),
      kcal: analyzed.kcal,
      protein: analyzed.protein,
      fats: analyzed.fats,
      carbs: analyzed.carbs,
      photo: state.pendingPhoto?.thumb || '',
    });

    if (!save(STORAGE_KEYS.meals, state.meals)) {
      // Квота закончилась: убираем фото у этой записи и пробуем снова
      state.meals[state.meals.length - 1].photo = '';
      save(STORAGE_KEYS.meals, state.meals);
    }

    closeModal($('modal-add-meal'));
    renderAll();
    toast(`${analyzed.kcal} ккал · записано`, 'success');
  } catch (err) {
    console.error('Распознавание не удалось:', err);
    setFormError(form, err.message);
  } finally {
    restore();
  }
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
    info.appendChild(el('h4', 'meal-name', meal.title));
    info.appendChild(el('time', 'meal-time', `${meal.time} · ${meal.grams} г`));

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

    // Состав: свёрнут по умолчанию, чтобы лента не превращалась в простыню
    if (meal.ingredients?.length) {
      const details = el('details', 'meal-details');
      const summary = el('summary', 'meal-details-summary', 'Состав');
      const composition = el('p', 'meal-composition');
      composition.textContent = meal.ingredients
        .map((i) => `${i.name} ${i.grams} г`)
        .join(' · ');
      details.append(summary, composition);
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
  renderProgress();
}

/* =========================================================
   15б. НАСТРОЙКИ И СБРОС ДАННЫХ
   ========================================================= */

/** Показывает в настройках, задан ли ключ (сам ключ не раскрываем) */
function renderSettings() {
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
 * Удаляет данные пользователя и возвращает приложение на онбординг.
 * keepKey = true оставляет ключ OpenRouter (частый случай при тестах).
 */
function resetAllData({ keepKey = true } = {}) {
  const keys = [STORAGE_KEYS.profile, STORAGE_KEYS.goals, STORAGE_KEYS.metrics, STORAGE_KEYS.meals];
  keys.forEach((key) => localStorage.removeItem(key));
  if (!keepKey) localStorage.removeItem(API_KEY_STORAGE);

  // Сбрасываем состояние в памяти, иначе старые данные останутся в интерфейсе
  state.profile = null;
  state.goals = { ...DEFAULT_GOALS };
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

  $('btn-add-ingredient').addEventListener('click', () => {
    addIngredientRow();
    const inputs = $('ingredients').querySelectorAll('.ingredient-name');
    inputs[inputs.length - 1].focus();
  });

  resetIngredients();
  renderAll();
}

// Запускаем сразу, если DOM уже разобран, иначе ждём DOMContentLoaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
