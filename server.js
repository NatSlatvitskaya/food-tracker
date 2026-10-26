/**
 * Nutlet Food Agent — сервер для Telegram-бота и API трекера.
 *
 *  1. Бот @nutlet_food_agent_bot: /start с кнопкой Web App.
 *  2. Supabase: профиль, приёмы пищи, заметки по дням.
 *  3. POST /api/analyze-meal — анализ еды через OpenRouter, ключ только на сервере.
 *  4. GET  /api/history      — архив за день для календаря.
 *
 * Запуск: node server.js
 */

'use strict';

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

require('dotenv').config();

/* =========================================================
   1. КОНФИГУРАЦИЯ
   ========================================================= */

const CONFIG = {
  port: Number(process.env.PORT || 3000),
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  webAppUrl: process.env.WEBAPP_URL || '',
  openRouterKey: process.env.OPENROUTER_API_KEY || '',
  openRouterUrl: 'https://openrouter.ai/api/v1/chat/completions',
  model: process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // Только для локальной отладки: разрешает telegram_id без подписи Telegram
  allowDevAuth: process.env.ALLOW_DEV_AUTH === 'true',
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 60000),
  maxImageBytes: Number(process.env.MAX_IMAGE_BYTES || 8 * 1024 * 1024),
};

/** Падаем на старте, если конфиг неполный, а не на первом запросе */
function validateConfig() {
  const required = [
    ['TELEGRAM_BOT_TOKEN', CONFIG.telegramToken],
    ['SUPABASE_URL', CONFIG.supabaseUrl],
    ['SUPABASE_SERVICE_ROLE_KEY', CONFIG.supabaseKey],
    ['OPENROUTER_API_KEY', CONFIG.openRouterKey],
    ['WEBAPP_URL', CONFIG.webAppUrl],
  ];

  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) {
    throw new Error(
      'Не заданы переменные окружения: ' + missing.join(', ') +
        '. Скопируйте .env.example в .env и заполните значения.'
    );
  }

  if (!/^https:\/\//.test(CONFIG.webAppUrl)) {
    console.warn('WEBAPP_URL не начинается с https:// — Telegram не откроет Web App по http.');
  }
}

/* =========================================================
   2. SUPABASE
   ========================================================= */

let supabase = null;

function getSupabase() {
  if (!supabase) {
    supabase = createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return supabase;
}

/* =========================================================
   3. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
   ========================================================= */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Категория приёма по времени «HH:MM». Границы те же, что во фронтенде */
function mealCategoryFor(time) {
  const hour = Number(String(time || '').slice(0, 2));
  if (!Number.isFinite(hour)) return 'snack';
  if (hour >= 5 && hour < 11) return 'breakfast';
  if (hour >= 11 && hour < 16) return 'lunch';
  if (hour >= 16 && hour < 23) return 'dinner';
  return 'snack';
}

function toISODate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function toHHMM(date = new Date()) {
  return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
}

function roundTo(value, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

/** Число или null: null значит «данных нет», а не ноль */
function micro(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/* =========================================================
   4. АВТОРИЗАЦИЯ TELEGRAM WEB APP
   ========================================================= */

/**
 * Проверяет подпись initData от Telegram Web App.
 *
 * Алгоритм из документации Telegram:
 *   secret = HMAC_SHA256("WebAppData", bot_token)
 *   hash   = HMAC_SHA256(secret, data_check_string)
 *
 * Возвращает объект пользователя или null, если подпись не сходится.
 */
function verifyInitData(initData) {
  if (!initData || typeof initData !== 'string') return null;

  let params;
  try {
    params = new URLSearchParams(initData);
  } catch (_) {
    return null;
  }

  const hash = params.get('hash');
  if (!hash) return null;

  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .map(([key, value]) => key + '=' + value)
    .sort()
    .join('\n');

  const secret = crypto
    .createHmac('sha256', 'WebAppData')
    .update(CONFIG.telegramToken)
    .digest();

  const expected = crypto
    .createHmac('sha256', secret)
    .update(dataCheckString)
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(hash, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  // Срок жизни initData — сутки
  const authDate = Number(params.get('auth_date'));
  if (Number.isFinite(authDate)) {
    const ageSeconds = Date.now() / 1000 - authDate;
    if (ageSeconds > 86400) return null;
  }

  try {
    const user = JSON.parse(params.get('user') || '{}');
    if (!user || !user.id) return null;
    return { id: Number(user.id), firstName: user.first_name || '', username: user.username || '' };
  } catch (_) {
    return null;
  }
}

/** Достаёт пользователя из запроса: подпись Telegram или dev-режим */
function authenticate(req) {
  const initData = req.get('x-telegram-init-data') || req.body?.initData || '';
  const fromSignature = verifyInitData(initData);
  if (fromSignature) return fromSignature;

  if (CONFIG.allowDevAuth && req.body?.telegramId) {
    const id = Number(req.body.telegramId);
    if (Number.isInteger(id) && id > 0) return { id, firstName: 'Dev', username: 'dev' };
  }

  return null;
}

/* =========================================================
   5. OPENROUTER
   ========================================================= */

/** Промпт анализа приёма. Повторяет правила фронтенда */
function buildMealPrompt({ ingredients, drinks, title, time, goalSplit, hasPhoto }) {
  const lines = [];

  lines.push(
    hasPhoto
      ? 'Проанализируй фото этого приёма пищи и указанный состав.'
      : 'Проанализируй состав приёма пищи.'
  );

  if (title) lines.push('Блюдо: ' + title + '.');

  if (ingredients.length) {
    const list = ingredients.map((i) => i.name + ' — ' + i.grams + ' г').join(', ');
    const total = ingredients.reduce((sum, i) => sum + (Number(i.grams) || 0), 0);
    lines.push('Еда (вес в граммах): ' + list + '. Общий вес еды: ' + total + ' г.');
  }

  if (drinks.length) {
    const list = drinks.map((d) => d.name + ' — ' + d.ml + ' мл').join(', ');
    const total = drinks.reduce((sum, d) => sum + (Number(d.ml) || 0), 0);
    lines.push('Напитки (объём в миллилитрах): ' + list + '. Общий объём: ' + total + ' мл.');
    lines.push(
      'Для напитков пересчитывай объём в вес по плотности (вода и кофе ≈ 1 г/мл, ' +
        'молоко ≈ 1.03 г/мл, сок ≈ 1.05 г/мл) и учитывай калорийность по составу.'
    );
  }

  lines.push('Рассчитай КБЖУ всего приёма пищи — еды и напитков вместе.');
  lines.push(
    'Дополнительно оцени клетчатку (fiber, граммы), натрий (sodium, миллиграммы) ' +
      'и сахар (sugar, граммы). Если по продукту данных нет — верни null.'
  );

  lines.push(
    'При расчёте КБЖУ продуктов и блюд строго ориентируйся на справочные данные продуктов, ' +
      'популярных на рынке СНГ и РФ. Учитывай особенности локальных брендов, если они указаны в тексте:'
  );
  lines.push(
    '- Сыр Чеддер (Брест-Литовск) содержит примерно 260–290 ккал и около 20–23 г жира на 100 г ' +
      '(он менее жирный, чем классический европейский Чеддер).'
  );
  lines.push(
    '- Российские сосиски (например, сочные, молочные, Папа Может) в среднем содержат 250–280 ккал ' +
      'и около 20–24 г жира на 100 г.'
  );
  lines.push(
    '- Если пользователь указывает конкретную марку (Barilla, Брест-Литовск, Магнит, Вкусно и Точка, Цех 85), ' +
      'старайся брать КБЖУ именно этих линеек из своей базы знаний, а не среднемировые значения. ' +
      'Будь аккуратнее с жирами, не завышай их для полуфабрикатов и сыров.'
  );

  if (goalSplit) {
    lines.push(
      'Цель пользователя: белки ' + goalSplit.protein + '%, жиры ' + goalSplit.fats +
        '%, углеводы ' + goalSplit.carbs + '% от калорий. Посчитай долю каждого макроса в калориях ' +
        'ЭТОГО приёма (белки и углеводы — 4 ккал/г, жиры — 9 ккал/г).'
    );
    lines.push(
      'Если доля какого-либо макроса отличается от цели больше чем на 10 процентных пунктов, это перекос. ' +
        'В поле "ai_recommendation" напиши одну короткую рекомендацию по-русски строго в формате: ' +
        '"Чтобы сбалансировать это блюдо под вашу цель, в следующий раз рекомендуется уменьшить ' +
        '[название продукта из списка] на [X] грамм. Это сэкономит [Y] ккал." ' +
        'Если перекоса нет — оставь "ai_recommendation" пустой строкой или напиши короткую похвалу.'
    );
  }

  lines.push(
    'Рассчитай КБЖУ КАЖДОЙ позиции отдельно (каждый продукт и каждый напиток), в массиве "items". ' +
      'Итоги "calories", "protein", "fat", "carbs" должны быть суммой позиций.'
  );
  lines.push('Верни ответ СТРОГО в формате JSON без markdown:');
  lines.push(
    '{"title": "Название на русском", "items": [{"name": "Продукт", "grams": 80, "calories": 210, ' +
      '"protein": 14, "fat": 17, "carbs": 1}], "calories": 450, "protein": 30, "fat": 15, ' +
      '"carbs": 48, "fiber": 4.5, "sodium": 320, "sugar": 5, "ai_recommendation": ""}'
  );

  if (time) lines.push('Время приёма: ' + time + '.');

  return lines.join(' ');
}

/** Вызов OpenRouter с таймаутом */
async function callOpenRouter(messages, maxTokens = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);

  try {
    const response = await fetch(CONFIG.openRouterUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: 'Bearer ' + CONFIG.openRouterKey,
        'Content-Type': 'application/json',
        'HTTP-Referer': CONFIG.webAppUrl || 'https://localhost',
        'X-Title': 'Nutlet Food Agent',
      },
      body: JSON.stringify({
        model: CONFIG.model,
        temperature: 0.2,
        max_tokens: maxTokens,
        messages,
      }),
    });

    if (!response.ok) {
      let details = '';
      try {
        const data = await response.json();
        details = data?.error?.message || '';
      } catch (_) {
        /* тело не JSON — оставляем пустым */
      }
      const error = new Error(details || 'OpenRouter вернул HTTP ' + response.status);
      error.status = response.status;
      throw error;
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) {
      const reason = data?.choices?.[0]?.finish_reason || 'неизвестно';
      throw new Error('Модель вернула пустой ответ (причина: ' + reason + ')');
    }
    return text;
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeout = new Error('Модель не ответила за ' + Math.round(CONFIG.requestTimeoutMs / 1000) + ' секунд');
      timeout.status = 'timeout';
      throw timeout;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Достаёт JSON из ответа модели, даже если он в ```json блоке */
function parseModelJson(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('Модель вернула пустой ответ');

  const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('В ответе модели нет JSON');
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

/** Позиции из ответа модели */
function parseItems(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((it) => it && typeof it === 'object' && String(it.name || '').trim())
    .map((it) => ({
      name: String(it.name).trim().slice(0, 120),
      grams: roundTo(it.grams ?? it.ml, 0),
      calories: roundTo(it.calories, 0),
      protein: roundTo(it.protein, 1),
      fats: roundTo(it.fat ?? it.fats, 1),
      carbs: roundTo(it.carbs, 1),
    }));
}

/**
 * Итог приёма: если модель вернула позиции — сумма позиций,
 * иначе — итоги из ответа. Карточка всегда сходится со списком.
 */
function totalsFromItems(items, fallback) {
  if (!items.length) return { ...fallback, source: 'model' };

  const sum = items.reduce(
    (acc, it) => ({
      kcal: acc.kcal + it.calories,
      protein: acc.protein + it.protein,
      fats: acc.fats + it.fats,
      carbs: acc.carbs + it.carbs,
    }),
    { kcal: 0, protein: 0, fats: 0, carbs: 0 }
  );

  return {
    kcal: Math.round(sum.kcal),
    protein: roundTo(sum.protein, 1),
    fats: roundTo(sum.fats, 1),
    carbs: roundTo(sum.carbs, 1),
    source: 'items',
  };
}

/** Нормализует ответ модели в формат фронтенда */
function normalizeMeal(data, { date, time, category, title }) {
  const items = parseItems(data.items);
  const totals = totalsFromItems(items, {
    kcal: roundTo(data.calories, 0),
    protein: roundTo(data.protein, 1),
    fats: roundTo(data.fat ?? data.fats, 1),
    carbs: roundTo(data.carbs, 1),
  });

  if (!(totals.kcal > 0 && totals.kcal < 8000)) {
    throw new Error('Модель вернула некорректную калорийность');
  }

  return {
    date,
    time,
    category,
    title: String(title || data.title || 'Приём пищи').slice(0, 120),
    calories: totals.kcal,
    protein: totals.protein,
    fats: totals.fats,
    carbs: totals.carbs,
    fiber: micro(data.fiber),
    sodium: micro(data.sodium),
    sugar: micro(data.sugar),
    ai_recommendation:
      typeof data.ai_recommendation === 'string' ? data.ai_recommendation.trim().slice(0, 300) : '',
    items,
    totalSource: totals.source,
  };
}

/* =========================================================
   6. РАБОТА С БАЗОЙ
   ========================================================= */

/** Профиль пользователя: нужен для целей БЖУ в промпте */
async function loadProfile(telegramId) {
  const { data, error } = await getSupabase()
    .from('users_profile')
    .select('*')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  if (error) {
    console.warn('Не удалось прочитать профиль:', error.message);
    return null;
  }
  return data;
}

/** Проценты БЖУ из профиля или пресет цели */
function profileSplit(profile) {
  if (!profile) return null;

  const p = Number(profile.split_protein);
  const f = Number(profile.split_fats);
  const c = Number(profile.split_carbs);
  if (Number.isFinite(p) && Number.isFinite(f) && Number.isFinite(c) && p + f + c > 0) {
    return { protein: p, fats: f, carbs: c };
  }

  const presets = {
    lose: { protein: 35, fats: 30, carbs: 35 },
    maintain: { protein: 25, fats: 30, carbs: 45 },
    gain: { protein: 30, fats: 25, carbs: 45 },
  };
  return presets[profile.goal] || presets.maintain;
}

/** Сохраняет приём пищи и возвращает запись с id */
async function saveMeal(telegramId, meal) {
  const row = {
    telegram_id: telegramId,
    date: meal.date,
    time: meal.time,
    category: meal.category,
    title: meal.title,
    calories: meal.calories,
    protein: meal.protein,
    fats: meal.fats,
    carbs: meal.carbs,
    fiber: meal.fiber,
    sodium: meal.sodium,
    sugar: meal.sugar,
    ai_recommendation: meal.ai_recommendation,
    items: meal.items,
  };

  const { data, error } = await getSupabase()
    .from('meals_history')
    .insert(row)
    .select()
    .single();

  if (error) throw new Error('Не удалось сохранить приём пищи: ' + error.message);
  return data;
}

/** Сумма за день по записям из базы */
function sumDay(meals) {
  const totals = {
    calories: 0, protein: 0, fats: 0, carbs: 0,
    fiber: 0, sodium: 0, sugar: 0,
    fiberCount: 0, sodiumCount: 0, sugarCount: 0,
  };

  meals.forEach((m) => {
    totals.calories += Number(m.calories) || 0;
    totals.protein += Number(m.protein) || 0;
    totals.fats += Number(m.fats) || 0;
    totals.carbs += Number(m.carbs) || 0;

    ['fiber', 'sodium', 'sugar'].forEach((key) => {
      const value = m[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        totals[key] += value;
        totals[key + 'Count'] += 1;
      }
    });
  });

  return {
    calories: Math.round(totals.calories),
    protein: roundTo(totals.protein, 1),
    fats: roundTo(totals.fats, 1),
    carbs: roundTo(totals.carbs, 1),
    fiber: totals.fiberCount ? roundTo(totals.fiber, 1) : null,
    sodium: totals.sodiumCount ? roundTo(totals.sodium, 0) : null,
    sugar: totals.sugarCount ? roundTo(totals.sugar, 1) : null,
  };
}

/* =========================================================
   7. EXPRESS
   ========================================================= */

const app = express();
app.disable('x-powered-by');

app.use(
  cors({
    origin(origin, callback) {
      // Запросы без Origin (curl, серверные) пропускаем
      if (!origin) return callback(null, true);
      if (!CONFIG.allowedOrigins.length) return callback(null, true);
      if (CONFIG.allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Origin не разрешён: ' + origin));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-telegram-init-data'],
    maxAge: 86400,
  })
);

// Base64 картинка заметно увеличивает тело запроса
app.use(express.json({ limit: '12mb' }));

/** Простой лог запросов */
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    console.log(req.method, req.path, res.statusCode, Date.now() - started + 'ms');
  });
  next();
});

app.get('/health', (req, res) => {
  res.json({ ok: true, model: CONFIG.model, time: new Date().toISOString() });
});

/**
 * POST /api/analyze-meal
 *
 * Тело:
 *   ingredients: [{ name, grams }]
 *   drinks:      [{ name, ml }]
 *   photo:       "data:image/jpeg;base64,..." или чистый base64
 *   title, time, date, initData
 *
 * Ответ: нормализованный приём пищи + id записи в базе.
 */
app.post('/api/analyze-meal', async (req, res) => {
  try {
    const user = authenticate(req);
    if (!user) return res.status(401).json({ error: 'Нет достоверной авторизации Telegram' });

    const { ingredients = [], drinks = [], photo = '', title = '', time, date } = req.body || {};

    if (!Array.isArray(ingredients) || !Array.isArray(drinks)) {
      return res.status(400).json({ error: 'ingredients и drinks должны быть массивами' });
    }

    const food = ingredients
      .filter((i) => i && String(i.name || '').trim() && Number(i.grams) > 0)
      .map((i) => ({ name: String(i.name).trim().slice(0, 120), grams: Number(i.grams) }));

    const liquid = drinks
      .filter((d) => d && String(d.name || '').trim() && Number(d.ml) > 0)
      .map((d) => ({ name: String(d.name).trim().slice(0, 120), ml: Number(d.ml) }));

    if (!food.length && !liquid.length && !photo) {
      return res.status(400).json({ error: 'Добавьте хотя бы один продукт или фото' });
    }

    // Проверка размера фото
    let imageUrl = '';
    if (photo) {
      if (typeof photo !== 'string') {
        return res.status(400).json({ error: 'photo должен быть строкой base64' });
      }
      imageUrl = photo.startsWith('data:') ? photo : 'data:image/jpeg;base64,' + photo;
      const approxBytes = Math.round((imageUrl.length * 3) / 4);
      if (approxBytes > CONFIG.maxImageBytes) {
        return res.status(413).json({ error: 'Фото слишком большое, сожмите его перед отправкой' });
      }
    }

    const mealDate = DATE_RE.test(String(date || '')) ? String(date) : toISODate();
    const mealTime = TIME_RE.test(String(time || '')) ? String(time) : toHHMM();
    const category = mealCategoryFor(mealTime);

    const profile = await loadProfile(user.id);
    const prompt = buildMealPrompt({
      ingredients: food,
      drinks: liquid,
      title,
      time: mealTime,
      goalSplit: profileSplit(profile),
      hasPhoto: Boolean(imageUrl),
    });

    const content = [{ type: 'text', text: prompt }];
    if (imageUrl) content.push({ type: 'image_url', image_url: { url: imageUrl } });

    const raw = await callOpenRouter([{ role: 'user', content }]);
    const parsed = parseModelJson(raw);
    const meal = normalizeMeal(parsed, {
      date: mealDate,
      time: mealTime,
      category,
      title,
    });

    const saved = await saveMeal(user.id, meal);

    res.json({
      ok: true,
      meal: { ...meal, id: saved.id },
    });
  } catch (err) {
    console.error('analyze-meal:', err.message);
    const status = err.status === 'timeout' ? 504 : err.status === 401 ? 401 : 500;
    res.status(status).json({ error: err.message });
  }
});

/**
 * GET /api/history?date=YYYY-MM-DD
 * Заголовок: x-telegram-init-data
 *
 * Ответ: приёмы за день, сумма и заметка — для календаря.
 */
app.get('/api/history', async (req, res) => {
  try {
    const initData = req.get('x-telegram-init-data') || req.query.initData || '';
    let user = verifyInitData(initData);

    if (!user && CONFIG.allowDevAuth && req.query.telegramId) {
      const id = Number(req.query.telegramId);
      if (Number.isInteger(id) && id > 0) user = { id, firstName: 'Dev' };
    }
    if (!user) return res.status(401).json({ error: 'Нет достоверной авторизации Telegram' });

    const date = String(req.query.date || toISODate());
    if (!DATE_RE.test(date)) {
      return res.status(400).json({ error: 'Дата должна быть в формате YYYY-MM-DD' });
    }

    const { data: meals, error } = await getSupabase()
      .from('meals_history')
      .select('*')
      .eq('telegram_id', user.id)
      .eq('date', date)
      .order('time', { ascending: true });

    if (error) throw new Error('Не удалось прочитать приёмы: ' + error.message);

    const { data: note, error: noteError } = await getSupabase()
      .from('daily_notes')
      .select('note')
      .eq('telegram_id', user.id)
      .eq('date', date)
      .maybeSingle();

    if (noteError) console.warn('Заметка не прочитана:', noteError.message);

    res.json({
      ok: true,
      date,
      meals: meals || [],
      count: (meals || []).length,
      totals: sumDay(meals || []),
      note: note?.note ?? null,
    });
  } catch (err) {
    console.error('history:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** Неизвестный маршрут */
app.use((req, res) => res.status(404).json({ error: 'Маршрут не найден' }));

/** Ошибки Express (включая CORS) */
app.use((err, req, res, next) => {
  if (err.message && err.message.startsWith('Origin не разрешён')) {
    return res.status(403).json({ error: err.message });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Слишком большое тело запроса' });
  }
  console.error('Необработанная ошибка:', err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

/* =========================================================
   8. TELEGRAM-БОТ
   ========================================================= */

function buildBot() {
  const bot = new Telegraf(CONFIG.telegramToken);

  bot.start(async (ctx) => {
    const keyboard = Markup.keyboard([
      [Markup.button.webApp('Открыть трекер', CONFIG.webAppUrl)],
    ])
      .resize()
      .persistent();

    await ctx.reply(
      'Привет, Наталья! Добро пожаловать в твой персональный ИИ-хаб здоровья.',
      keyboard
    );
  });

  bot.command('app', async (ctx) => {
    const keyboard = Markup.keyboard([
      [Markup.button.webApp('Открыть трекер', CONFIG.webAppUrl)],
    ]).resize();

    await ctx.reply('Трекер открывается кнопкой ниже.', keyboard);
  });

  bot.catch((err, ctx) => {
    console.error('Ошибка бота на обновлении', ctx.updateType, err.message);
  });

  return bot;
}

/* =========================================================
   9. ЗАПУСК
   ========================================================= */

async function main() {
  validateConfig();

  const server = app.listen(CONFIG.port, () => {
    console.log('HTTP-сервер слушает порт ' + CONFIG.port);
    console.log('Модель: ' + CONFIG.model);
  });

  const bot = buildBot();

  try {
    await bot.telegram.setMyCommands([
      { command: 'start', description: 'Начать и открыть трекер' },
      { command: 'app', description: 'Открыть трекер' },
    ]);
    // launch не блокирует: HTTP продолжает работать независимо от бота
    bot.launch({ dropPendingUpdates: true });
    console.log('Бот запущен');
  } catch (err) {
    console.error('Бот не запустился:', err.message);
  }

  const shutdown = async (signal) => {
    console.log('Остановка по сигналу ' + signal);
    try {
      bot.stop(signal);
    } catch (_) {
      /* бот мог не запуститься */
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Сервер не запустился:', err.message);
    process.exit(1);
  });
}

module.exports = { app, buildBot, verifyInitData, mealCategoryFor, sumDay, normalizeMeal };
