/* =========================================================
   app.js — логика трекера питания
   Всё хранится в localStorage. Без сборки и зависимостей.
   ========================================================= */

'use strict';

/* =========================================================
   1. КОНСТАНТЫ
   ========================================================= */

// Ключи, под которыми данные лежат в localStorage
const STORAGE_KEYS = {
  profile: 'tracker.profile', // данные онбординга: возраст, целевой вес и т.п.
  goals:   'tracker.goals',   // цели КБЖУ
  metrics: 'tracker.metrics', // история замеров (массив записей, по дате)
  meals:   'tracker.meals',   // приёмы пищи (массив записей)
};

// Дефолтные цели — временно, пока не подключён ИИ-агент Syntx
const DEFAULT_GOALS = { kcal: 1800, protein: 90, fats: 60, carbs: 180 };

// Временная оценка КБЖУ на 100 г блюда — заглушка вместо ответа агента
const STUB_PER_100G = { kcal: 150, protein: 8, fats: 6, carbs: 16 };

// Длина окружности кольца (r = 60). Совпадает с stroke-dasharray в CSS
const RING_LENGTH = 2 * Math.PI * 60;

const DEFAULT_PHOTO_LABEL = 'Загрузить фото / Сделать снимок';

/* =========================================================
   2. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
   ========================================================= */

/** Короткий доступ к элементу по id */
const $ = (id) => document.getElementById(id);

/** Создаёт элемент с классом и текстом (textContent — безопасно для пользовательского ввода) */
function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** Читает JSON из localStorage. При ошибке возвращает fallback */
function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    console.warn(`Не удалось прочитать ${key}:`, err);
    return fallback;
  }
}

/** Сохраняет значение в localStorage как JSON */
function save(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

/** Дата YYYY-MM-DD по ЛОКАЛЬНОМУ времени пользователя (toISOString даёт UTC, поэтому не используем) */
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

/* =========================================================
   3. СОСТОЯНИЕ
   ========================================================= */

const state = {
  profile: null,          // профиль пользователя или null (нет онбординга)
  goals: { ...DEFAULT_GOALS },
  metrics: [],            // замеры: { date, weight, waist, hips, glutes }
  meals: [],              // приёмы пищи: { id, date, time, name, weight, kcal, protein, fats, carbs }
  pendingPhotoName: '',   // имя выбранного в форме фото (сам файл в localStorage не сохраняем)
};

/** Загружает все данные из localStorage в state */
function loadState() {
  state.profile = load(STORAGE_KEYS.profile, null);
  state.goals = load(STORAGE_KEYS.goals, { ...DEFAULT_GOALS });
  state.metrics = load(STORAGE_KEYS.metrics, []);
  state.meals = load(STORAGE_KEYS.meals, []);
}

/**
 * Добавляет замер или заменяет запись за сегодня.
 * Так повторный замер в один день не создаёт дубликатов.
 */
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
   4. НАВИГАЦИЯ (ЭКРАНЫ И ТАББАР)
   ========================================================= */

/**
 * Показывает экран с нужным именем и подсвечивает кнопку таббара.
 * name: 'onboarding' | 'home' | 'history' | 'progress'
 */
function showScreen(name) {
  document.querySelectorAll('.screen').forEach((section) => {
    section.classList.toggle('active', section.id === `screen-${name}`);
  });
  document.querySelectorAll('.tab-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.screen === name);
  });
}

/** Нажатие на вкладку таббара: переключаем экран и обновляем данные */
function initTabs() {
  document.querySelectorAll('.tab-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      showScreen(btn.dataset.screen);
      renderAll();
    });
  });
}

/* =========================================================
   5. ОНБОРДИНГ
   ========================================================= */

/** Показывает онбординг и прячет таббар (класс is-onboarding на body) */
function showOnboarding() {
  document.body.classList.add('is-onboarding');
  showScreen('onboarding');
}

/** Прячет онбординг, показывает таббар и главную вкладку */
function hideOnboarding() {
  document.body.classList.remove('is-onboarding');
  showScreen('home');
}

/** При загрузке решает, что показать: онбординг или главную */
function initOnboarding() {
  if (state.profile) {
    hideOnboarding();
  } else {
    showOnboarding();
  }
  $('onboarding-form').addEventListener('submit', handleOnboardingSubmit);
}

/**
 * Обработчик кнопки "Рассчитать цель через ИИ-агента".
 * ВРЕМЕННАЯ версия: ИИ ещё не подключён, поэтому ставим дефолтные цели.
 */
function handleOnboardingSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const num = (name) => Number(form.elements[name].value);
  const today = toISODate();

  const profile = {
    currentWeight: num('current-weight'),
    waist: num('waist'),
    hips: num('hips'),
    glutes: num('glutes'),
    age: num('age'),
    targetWeight: num('target-weight'),
    createdAt: today,
  };

  // TODO: здесь появится запрос к ИИ-агенту Syntx, который вернёт цели КБЖУ.
  // Пока сохраняем дефолтные значения.
  state.profile = profile;
  state.goals = { ...DEFAULT_GOALS };

  // Данные онбординга становятся первым замером в истории прогресса
  upsertMetric({
    date: today,
    weight: profile.currentWeight,
    waist: profile.waist,
    hips: profile.hips,
    glutes: profile.glutes,
  });

  save(STORAGE_KEYS.profile, profile);
  save(STORAGE_KEYS.goals, state.goals);

  hideOnboarding();
  renderAll();
}

/* =========================================================
   6. МОДАЛЬНЫЕ ОКНА
   ========================================================= */

/** Открывает шторку (класс .open даёт display: flex в CSS) */
function openModal(modal) {
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
}

/** Закрывает шторку */
function closeModal(modal) {
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
}

/** Закрывает все открытые окна (например, по Escape) */
function closeAllModals() {
  document.querySelectorAll('.modal.open').forEach((modal) => closeModal(modal));
}

/** Подключает открытие и закрытие шторок */
function initModals() {
  $('btn-add-meal').addEventListener('click', () => {
    resetMealForm();
    openModal($('modal-add-meal'));
  });

  $('btn-add-metrics').addEventListener('click', () => {
    fillMetricsForm();
    openModal($('modal-add-metrics'));
  });

  // Крестик и подложка имеют атрибут data-close-modal
  document.querySelectorAll('[data-close-modal]').forEach((element) => {
    element.addEventListener('click', () => closeModal(element.closest('.modal')));
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeAllModals();
  });
}

/* =========================================================
   7. ДОБАВЛЕНИЕ ПРИЁМА ПИЩИ
   ========================================================= */

function resetMealForm() {
  $('form-meal').reset();
  state.pendingPhotoName = '';
  $('meal-photo-name').textContent = DEFAULT_PHOTO_LABEL;
}

/** Запоминает имя выбранного фото и показывает его в кнопке */
function handlePhotoChange(event) {
  const file = event.target.files[0];
  state.pendingPhotoName = file ? file.name : '';
  $('meal-photo-name').textContent = file ? file.name : DEFAULT_PHOTO_LABEL;
}

/**
 * ВРЕМЕННАЯ оценка КБЖУ по весу: считаем по заглушке на 100 г.
 * Когда подключим агента, эта функция будет заменена ответом API.
 */
function estimateNutrition(weightG) {
  const k = weightG / 100;
  return {
    kcal: Math.round(STUB_PER_100G.kcal * k),
    protein: Math.round(STUB_PER_100G.protein * k),
    fats: Math.round(STUB_PER_100G.fats * k),
    carbs: Math.round(STUB_PER_100G.carbs * k),
  };
}

/** Кнопка "Отправить агенту" */
function handleMealSubmit(event) {
  event.preventDefault();

  const weight = Number($('meal-weight').value);
  const name = $('meal-name').value.trim() || 'Приём пищи';
  if (!(weight > 0)) return;

  const now = new Date();
  state.meals.push({
    id: Date.now(),
    date: toISODate(now),
    time: now.toTimeString().slice(0, 5), // "HH:MM"
    name,
    weight,
    hasPhoto: Boolean(state.pendingPhotoName),
    ...estimateNutrition(weight),
  });

  save(STORAGE_KEYS.meals, state.meals);
  closeModal($('modal-add-meal'));
  renderAll();
}

/* =========================================================
   8. ЗАМЕРЫ (ВКЛАДКА "ПРОГРЕСС")
   ========================================================= */

/** Заполняет форму замеров последними значениями, чтобы было проще править */
function fillMetricsForm() {
  const last = state.metrics[state.metrics.length - 1];
  if (!last) return;
  $('new-weight').value = last.weight;
  $('new-waist').value = last.waist;
  $('new-hips').value = last.hips;
  $('new-glutes').value = last.glutes;
}

/** Кнопка "Сохранить замеры" */
function handleMetricsSubmit(event) {
  event.preventDefault();

  const entry = {
    date: toISODate(),
    weight: Number($('new-weight').value),
    waist: Number($('new-waist').value),
    hips: Number($('new-hips').value),
    glutes: Number($('new-glutes').value),
  };

  // Все значения должны быть положительными числами
  const values = [entry.weight, entry.waist, entry.hips, entry.glutes];
  if (values.some((v) => !(v > 0))) return;

  upsertMetric(entry);
  closeModal($('modal-add-metrics'));
  renderAll();
}

/* =========================================================
   9. ОТРИСОВКА (состояние → DOM)
   ========================================================= */

/** Дата и приветствие на Главной и в Истории */
function renderGreeting() {
  const now = new Date();
  const today = toISODate(now);
  $('current-date').textContent = formatLongDate(today);
  $('history-date').textContent = formatLongDate(today);
  $('greeting').textContent = greetingByHour(now.getHours());
}

/** Кольцо и число калорий */
function renderCalories(totals) {
  const goal = state.goals.kcal;
  const ratio = goal ? Math.min(totals.kcal / goal, 1) : 0;

  $('calorie-current').textContent = totals.kcal;
  $('calorie-target').textContent = goal;

  // Длина дуги = длина окружности * (1 - прогресс). Ноль смещения = полное кольцо
  const ring = $('ring-fill');
  ring.style.strokeDasharray = RING_LENGTH;
  ring.style.strokeDashoffset = RING_LENGTH * (1 - ratio);
}

/** Одна полоска БЖУ: key = 'protein' | 'fats' | 'carbs' */
function renderMacro(key, value) {
  const goal = state.goals[key];
  $(`${key}-consumed`).textContent = value;
  $(`${key}-goal`).textContent = goal;
  $(`${key}-bar`).style.width = `${percent(value, goal)}%`;
}

/** Лента приёмов пищи за день (создаём узлы через el(), без innerHTML) */
function renderMeals(todayMeals) {
  const list = $('meal-list');
  list.replaceChildren();
  $('history-empty').classList.toggle('hidden', todayMeals.length > 0);

  todayMeals.forEach((meal) => {
    const card = el('article', 'meal-card');

    const photo = el('div', 'meal-photo');
    photo.appendChild(el('div', 'meal-photo-placeholder', meal.hasPhoto ? '📷' : '🍽️'));

    const info = el('div', 'meal-info');
    info.appendChild(el('h4', 'meal-name', meal.name));
    info.appendChild(el('time', 'meal-time', `${meal.time} · ${meal.weight} г`));

    const macros = el('div', 'meal-macros');
    const parts = [`${meal.kcal} ккал`, `Б: ${meal.protein}г`, `Ж: ${meal.fats}г`, `У: ${meal.carbs}г`];
    parts.forEach((text, i) => {
      if (i > 0) macros.appendChild(el('span', '', '•'));
      macros.appendChild(el('span', '', text));
    });
    info.appendChild(macros);

    card.append(photo, info);
    list.appendChild(card);
  });
}

/** Карточки замеров: берём последнюю запись */
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

/** Перерисовка всего интерфейса из state. Вызывается после любого изменения */
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
   10. ИНИЦИАЛИЗАЦИЯ
   ========================================================= */

function initMealForm() {
  $('form-meal').addEventListener('submit', handleMealSubmit);
  $('meal-photo').addEventListener('change', handlePhotoChange);
}

function initMetricsForm() {
  $('form-metrics').addEventListener('submit', handleMetricsSubmit);
}

/** Точка входа: выполняется один раз после загрузки страницы */
function init() {
  loadState();
  initTabs();
  initOnboarding();
  initModals();
  initMealForm();
  initMetricsForm();
  renderAll();
}

document.addEventListener('DOMContentLoaded', init);
