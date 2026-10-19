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
const API_MODEL = 'google/gemini-flash-1.5';
const API_TIMEOUT_MS = 45000;

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
async function callModel(content, maxTokens = 500) {
  const apiKey = await ensureApiKey();
  if (!apiKey) {
    throw new Error('Нужен ключ OpenRouter');
  }

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
        // OpenRouter просит эти два заголовка для статистики, они необязательны
        'HTTP-Referer': location.origin,
        'X-Title': 'Food Tracker',
      },
      body: JSON.stringify({
        model: API_MODEL,
        temperature: 0.2,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content }],
      }),
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Модель не ответила за 45 секунд');
    }
    throw new Error('Нет связи с OpenRouter. Проверьте интернет.');
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
    if (response.status === 401) throw new Error('Ключ отклонён (401). Проверьте ключ');
    if (response.status === 402) throw new Error('Закончились кредиты OpenRouter (402)');
    if (response.status === 429) throw new Error('Слишком много запросов (429). Подождите минуту');
    throw new Error(`Ошибка OpenRouter ${response.status}${details ? `: ${details}` : ''}`);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Пустой ответ модели');
  return text;
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

/** Промпт для распознавания блюда */
function buildMealPrompt(grams) {
  return [
    'Проанализируй фото этого блюда.',
    `Его общий вес составляет ${grams} грамм.`,
    'Рассчитай КБЖУ этого приема пищи на основе состава.',
    'Верни ответ СТРОГО в формате JSON без markdown:',
    '{"title": "Название блюда на русском", "calories": 420, "protein": 25, "fat": 12, "carbs": 53}',
  ].join(' ');
}

/* =========================================================
   13. ПРИЁМ ПИЩИ: ОТПРАВКА АГЕНТУ
   ========================================================= */

/**
 * Собирает мультимодальный контент: текст + картинка в base64.
 * Формат image_url с data-url поддерживается OpenRouter.
 */
function buildMealContent(grams, photoDataUrl) {
  const parts = [{ type: 'text', text: buildMealPrompt(grams) }];
  if (photoDataUrl) {
    parts.push({ type: 'image_url', image_url: { url: photoDataUrl } });
  }
  return parts;
}

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
  const grams = Number($('meal-weight').value);

  setFormError(form, '');
  if (!(grams > 0)) {
    setFormError(form, 'Укажите вес блюда в граммах.');
    return;
  }

  const restore = setButtonLoading(button, 'ИИ анализирует…');

  try {
    // Если фото ещё обрабатывается — дождёмся, иначе уйдёт запрос без картинки
    if (state.photoTask) await state.photoTask;

    const content = buildMealContent(grams, state.pendingPhoto?.dataUrl);
    const raw = await callModel(content, 400);
    const analyzed = normalizeMeal(parseModelJson(raw));

    if (!analyzed) throw new Error('Не удалось распознать блюдо');

    const now = new Date();
    state.meals.push({
      id: Date.now(),
      date: toISODate(now),
      time: now.toTimeString().slice(0, 5),
      title: analyzed.title,
      grams,
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
    toast(`${analyzed.title}: ${analyzed.kcal} ккал`, 'success');
  } catch (err) {
    console.error('Распознавание не удалось:', err);
    setFormError(form, `${err.message}. Попробуйте ещё раз.`);
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
   16. ИНИЦИАЛИЗАЦИЯ
   ========================================================= */

function init() {
  loadState();
  initTabs();
  initOnboarding();
  initModals();
  $('form-meal').addEventListener('submit', handleMealSubmit);
  $('meal-photo').addEventListener('change', handlePhotoChange);
  $('form-metrics').addEventListener('submit', handleMetricsSubmit);
  renderAll();
}

// Запускаем сразу, если DOM уже разобран, иначе ждём DOMContentLoaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
