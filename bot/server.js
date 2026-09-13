const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const store = require('./store');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || null; // hali o'rnatilmagan bo'lishi mumkin
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null; // /admin panelga kirish uchun
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || '@bedeutungslosM';
const PORT = process.env.PORT || 3000;
const VERIFY_SESSION_TTL_MS = 15 * 60 * 1000; // 15 daqiqa

if(!BOT_TOKEN){
  console.error('XATOLIK: BOT_TOKEN environment variable topilmadi.');
  process.exit(1);
}
if(!ADMIN_PASSWORD){
  console.warn('OGOHLANTIRISH: ADMIN_PASSWORD o\'rnatilmagan — /admin paneli ishlamaydi (barcha so\'rovlar 401 qaytaradi).');
}
if(!ADMIN_TELEGRAM_ID){
  console.warn('OGOHLANTIRISH: ADMIN_TELEGRAM_ID o\'rnatilmagan — admin buyruqlari va bildirishnomalar ishlamaydi.');
}

/* Bot yoki server kutilmagan xatolik bilan yiqilib qolmasligi uchun — faqat log yozadi, jarayonni davom ettiradi. */
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection:', err && err.stack ? err.stack : err);
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err && err.stack ? err.stack : err);
});

function isAdmin(telegramId){
  return ADMIN_TELEGRAM_ID && String(telegramId) === String(ADMIN_TELEGRAM_ID);
}

function genTeacherKey(){
  return crypto.randomBytes(5).toString('hex');
}

/* ================= OBUNA (PREMIUM/PRO) ================= */
const FREE_WEEKLY_LIMIT = 3;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const TARIFFS = {
  premium_1m: { tier: 'premium', label: 'Premium — 1 oy', days: 30 },
  premium_3m: { tier: 'premium', label: 'Premium — 3 oy', days: 90 },
  pro_1m: { tier: 'pro', label: 'Pro — 1 oy', days: 30 }
};
const DEFAULT_SETTINGS = {
  cardNumber: '',
  cardHolder: '',
  prices: { premium_1m: 32000, premium_3m: 90000, pro_1m: 48999 }
};

function getSettings(){
  const data = store.load();
  const s = data.settings || {};
  return {
    cardNumber: s.cardNumber || DEFAULT_SETTINGS.cardNumber,
    cardHolder: s.cardHolder || DEFAULT_SETTINGS.cardHolder,
    prices: Object.assign({}, DEFAULT_SETTINGS.prices, s.prices || {})
  };
}

function tariffPrice(tariffKey){
  const settings = getSettings();
  return settings.prices[tariffKey] != null ? settings.prices[tariffKey] : DEFAULT_SETTINGS.prices[tariffKey];
}

/* Obuna hali kuchdami — muddati o'tgan bo'lsa avtomatik "free" hisoblanadi. */
function getSubscriptionInfo(telegramId){
  const data = store.load();
  const user = data.users[String(telegramId)];
  const tier = user && user.subscription_tier ? user.subscription_tier : 'free';
  const expiresAt = (user && user.subscription_expires_at) || null;
  const active = tier !== 'free' && expiresAt && new Date(expiresAt).getTime() > Date.now();
  return { tier: active ? tier : 'free', expiresAt, active };
}

function getWeeklyUsage(telegramId){
  const data = store.load();
  const user = data.users[String(telegramId)];
  if(!user) return { count: 0 };
  const resetAt = user.weekly_usage_reset_at ? new Date(user.weekly_usage_reset_at).getTime() : 0;
  if(Date.now() - resetAt >= WEEK_MS) return { count: 0 };
  return { count: user.weekly_usage_count || 0 };
}

/* Bepul foydalanuvchi uchun haftalik limitni tekshiradi va (ruxsat bo'lsa) darhol sarflaydi — bitta atomik amal. */
function checkAndConsumeQuota(telegramId){
  const sub = getSubscriptionInfo(telegramId);
  if(sub.active) return { allowed: true, tier: sub.tier, remaining: null };

  return store.update((data) => {
    const key = String(telegramId);
    if(!data.users[key]){
      data.users[key] = {
        telegram_id: Number(telegramId), username: null, first_name: null, role: 'student',
        display_name: null, teacher_key: null, is_paused: false,
        subscription_tier: 'free', subscription_expires_at: null,
        weekly_usage_count: 0, weekly_usage_reset_at: null,
        created_at: new Date().toISOString()
      };
    }
    const user = data.users[key];
    const resetAt = user.weekly_usage_reset_at ? new Date(user.weekly_usage_reset_at).getTime() : 0;
    if(Date.now() - resetAt >= WEEK_MS){
      user.weekly_usage_count = 0;
      user.weekly_usage_reset_at = new Date().toISOString();
    }
    if(user.weekly_usage_count >= FREE_WEEKLY_LIMIT){
      return { allowed: false, tier: 'free', remaining: 0 };
    }
    user.weekly_usage_count++;
    return { allowed: true, tier: 'free', remaining: FREE_WEEKLY_LIMIT - user.weekly_usage_count };
  });
}

function grantSubscription(telegramId, tariffKey){
  const tariff = TARIFFS[tariffKey];
  if(!tariff) return null;
  return store.update((data) => {
    const key = String(telegramId);
    if(!data.users[key]){
      data.users[key] = {
        telegram_id: Number(telegramId), username: null, first_name: null, role: 'student',
        display_name: null, teacher_key: null, is_paused: false,
        created_at: new Date().toISOString()
      };
    }
    const user = data.users[key];
    const now = Date.now();
    // Agar hozirgi obuna hali kuchda bo'lsa, muddat shundan qo'shiladi (stacking); aks holda bugundan boshlanadi.
    const currentExpiry = user.subscription_expires_at ? new Date(user.subscription_expires_at).getTime() : 0;
    const base = currentExpiry > now ? currentExpiry : now;
    const newExpiry = new Date(base + tariff.days * 24 * 60 * 60 * 1000).toISOString();
    user.subscription_tier = tariff.tier;
    user.subscription_expires_at = newExpiry;
    return { tier: tariff.tier, expiresAt: newExpiry };
  });
}

/* Ball tugmasi bosilganda "endi javob kutilmoqda" holatini saqlaydi: chatId -> {submissionId, messageId} */
const pendingScoreEntry = new Map();
/* Izoh yozish so'ralganda kutilayotgan holat: chatId -> submissionId */
const pendingCommentEntry = new Map();
/* /xabar tasdiqlanishini kutayotgan xabarlar: chatId -> {text, ids, scope} */
const pendingBroadcast = new Map();
/* /tozalash tasdiqlanishini kutayotgan holat: chatId -> true */
const pendingClear = new Map();
/* To'lov jarayonida: chatId -> tariffKey (screenshot kutilmoqda) */
const pendingPayment = new Map();

/* Admin panelga noto'g'ri parol bilan ko'p urinishlarni kuzatadi: ip -> {count, lockedUntil} */
const loginAttempts = new Map();

function gradeSubmission(submissionId, manualScore, fromUser){
  return store.update((data) => {
    const sub = data.submissions.find(s => s.id === submissionId);
    if(!sub) return { ok: false, error: "Bu ish topilmadi (eskirgan bo'lishi mumkin)." };
    const score = (manualScore != null) ? manualScore : (sub.ai_score !== '' ? Number(sub.ai_score) : null);
    if(score == null || Number.isNaN(score)){
      return { ok: false, error: "AI bali mavjud emas — \"Ball kiritish\" orqali qo'lda kiriting." };
    }
    sub.final_score = score;
    sub.graded_by = fromUser.first_name || fromUser.username || String(fromUser.id);
    sub.graded_by_id = fromUser.id;
    sub.graded_at = new Date().toISOString();
    return { ok: true, score };
  });
}

function scoreEmoji(score){
  if(score >= 80) return '🟢';
  if(score >= 60) return '🟡';
  return '🔴';
}

/* Ball qo'yilgandan keyin ixtiyoriy izoh so'raydi */
function askForComment(chatId, submissionId){
  bot.sendMessage(chatId, "💬 Ushbu ish uchun o'quvchiga izoh qoldirmoqchimisiz? (ixtiyoriy)", {
    reply_markup: { inline_keyboard: [[
      { text: '✏️ Izoh yozish', callback_data: `addcomment_${submissionId}` },
      { text: "Yo'q, kifoya", callback_data: `skipcomment_${submissionId}` }
    ]] }
  }).catch((e)=> console.error('askForComment xatolik:', e.message));
}

/* Ball qo'yilganda — izohdan qat'i nazar — o'quvchiga darhol xabar beradi (agar uning Telegram ID'si bog'langan bo'lsa). */
async function notifyStudentOfScore(submissionId){
  const data = store.load();
  const sub = data.submissions.find(s => s.id === submissionId);
  if(!sub || !sub.student_telegram_id || sub.final_score == null) return;
  try{
    await bot.sendMessage(sub.student_telegram_id,
      `✅ Ishingiz baholandi!\n\n📌 ${sub.task_title || 'Schreiben'}\n${scoreEmoji(sub.final_score)} Ball: ${sub.final_score}/100\n\nBatafsil: /cv`
    );
  }catch(err){
    console.error(`o'quvchiga (${sub.student_telegram_id}) ball haqida xabar berishda xatolik:`, err.message);
  }
}

function csvEscape(v){
  let s = String(v == null ? '' : v);
  // CSV/Excel formula in'ektsiyasidan himoya: =, +, -, @ bilan boshlansa oldiga bo'sh belgi qo'yiladi
  if(/^[=+\-@]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}
function toCSV(rows){
  const header = ['ID', 'Sana', 'Talaba', 'Daraja/Bo\'lim', 'Toifa', 'Mavzu', 'Ball', 'Baholadi', 'Baholangan vaqt', 'Izoh'];
  // "sep=," — Excel'ga ustunlarni vergul bilan ajratishni majburlaydi. Ba'zi tillarda (shu jumladan
  // o'zbek/rus Windows sozlamalarida) Excel vergul o'rniga nuqta-vergulni kutadi va shu direktivasiz
  // butun qatorni bitta ustunga "yopishtirib" ochadi.
  const lines = ['sep=,', header.map(csvEscape).join(',')];
  rows.forEach(r => {
    lines.push([
      r.id,
      r.created_at,
      r.student_name,
      r.level,
      r.category,
      r.task_title,
      r.final_score != null ? r.final_score : (r.ai_score || ''),
      r.graded_by || '',
      r.graded_at || '',
      r.teacher_comment || ''
    ].map(csvEscape).join(','));
  });
  return lines.join('\r\n');
}

function upsertUser(from){
  return store.update((data) => {
    const key = String(from.id);
    const existing = data.users[key];
    const role = isAdmin(from.id) ? 'admin' : (existing ? existing.role : 'student');
    data.users[key] = Object.assign({}, existing, {
      telegram_id: from.id,
      username: from.username || null,
      first_name: from.first_name || null,
      role,
      display_name: existing ? (existing.display_name || null) : null,
      teacher_key: existing ? (existing.teacher_key || null) : null,
      is_paused: existing ? !!existing.is_paused : false,
      last_submission_at: existing ? (existing.last_submission_at || null) : null,
      last_reminder_sent_at: existing ? (existing.last_reminder_sent_at || null) : null,
      created_at: existing ? existing.created_at : new Date().toISOString()
    });
    return data.users[key];
  });
}

function promoteToTeacher(telegramId, displayName){
  return store.update((data) => {
    const key = String(telegramId);
    const existing = data.users[key];
    const teacherKey = (existing && existing.teacher_key) || genTeacherKey();
    data.users[key] = Object.assign({
      telegram_id: Number(telegramId),
      username: null,
      first_name: null,
      is_paused: false,
      created_at: new Date().toISOString()
    }, existing, {
      role: 'teacher',
      display_name: displayName || (existing && existing.display_name) || null,
      teacher_key: teacherKey
    });
    return data.users[key];
  });
}

/* ================= TELEGRAM BOT ================= */
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
bot.on('polling_error', (err) => console.error('polling_error:', err.message));

let BOT_USERNAME = null;
bot.getMe().then((me) => { BOT_USERNAME = me.username; }).catch((err) => console.error('getMe xatolik:', err.message));

const PUBLIC_BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : (process.env.PUBLIC_BASE_URL || null);
const SITE_URL = process.env.SITE_URL || 'https://prufungs.netlify.app';

/* Har bir rol uchun mos inline asosiy menyu. */
function mainMenuKeyboard(user, telegramId){
  if(isAdmin(telegramId)){
    const rows = [
      [{ text: '📊 Jadval', callback_data: 'menu_jadval' }, { text: '🏆 Reyting', callback_data: 'menu_reyting' }],
      [{ text: '📥 Export CSV', callback_data: 'menu_export' }, { text: '👥 Ustozlar', callback_data: 'menu_teachers' }]
    ];
    if(PUBLIC_BASE_URL) rows.push([{ text: '🌐 Admin panel', url: `${PUBLIC_BASE_URL}/admin` }]);
    return { inline_keyboard: rows };
  }
  if(user && user.role === 'teacher'){
    return { inline_keyboard: [
      [{ text: '📊 Jadval', callback_data: 'menu_jadval' }, { text: '🏆 Reyting', callback_data: 'menu_reyting' }],
      [{ text: '📥 Export CSV', callback_data: 'menu_export' }],
      [ user.is_paused
          ? { text: '▶️ Faollashish', callback_data: 'menu_toggle_pause' }
          : { text: '⏸ Band bo\'lish', callback_data: 'menu_toggle_pause' } ]
    ]};
  }
  return { inline_keyboard: [
    [{ text: '📋 Mening natijalarim', callback_data: 'menu_cv' }],
    [{ text: '💎 Premium/Pro sotib olish', callback_data: 'menu_premium' }]
  ]};
}

/* Ustoz birinchi marta qo'shilganda unga xush kelibsiz xabari yuboradi (admin panel yoki /addteacher orqali qo'shilganidan qat'i nazar). */
async function notifyNewTeacherIfNeeded(beforeUser, teacher){
  const wasTeacherAlready = beforeUser && beforeUser.role === 'teacher';
  if(wasTeacherAlready) return;
  try{
    await bot.sendMessage(teacher.telegram_id,
      `🎉 Tabriklaymiz! Siz${teacher.display_name ? ' "' + teacher.display_name + '"' : ''} nomi bilan ustoz sifatida qo'shildingiz.\n\n` +
      `Endi o'quvchilar sizni tanlashi mumkin — ularning Schreiben ishlari to'g'ridan-to'g'ri shu yerga keladi.`,
      { reply_markup: mainMenuKeyboard({ role: 'teacher', is_paused: false }, teacher.telegram_id) }
    );
  }catch(err){
    console.error(`yangi ustozga (${teacher.telegram_id}) xabar yuborishda xatolik:`, err.message);
  }
}

/* Rolga mos buyruqlar ro'yxati — /start va /yordam ikkalasida ishlatiladi. */
function buildCommandLines(user, telegramId){
  const lines = [];
  if(isAdmin(telegramId)){
    lines.push('Siz adminsiz. Buyruqlar:', '/addteacher <id> <Ism Familya> — ustoz qo\'shish', '/removeteacher <id> — ustozni olib tashlash', '/teachers — ustozlar ro\'yxati', '/jadval — so\'nggi baholangan ishlar', '/reyting — eng yaxshi natijalar', '/export — barcha natijalar CSV', '/tahrirla <id> <ball> — ballni tuzatish', '/tozalash — jadvalni butunlay tozalash', '/xabar <matn> — barcha o\'quvchilarga xabar yuborish', '/yordam — shu ro\'yxatni qayta ko\'rish', '', 'Yoki /admin panelidan foydalaning.');
  } else if(user.role === 'teacher'){
    lines.push(`Siz ustoz sifatida ro'yxatdan o'tgansiz${user.display_name ? ' (' + user.display_name + ')' : ''}. Sizni tanlagan o'quvchilarning Schreiben ishlari shu yerga keladi.`, '', 'Buyruqlar:', '/jadval — so\'nggi baholangan ishlaringiz', '/reyting — o\'quvchilaringiz reytingi', '/export — o\'z natijalaringiz CSV', '/tahrirla <id> <ball> — o\'z o\'quvchingiz ballini tuzatish', '/xabar <matn> — o\'z o\'quvchilaringizga xabar yuborish', '/pauza — vaqtincha yangi ish qabul qilmaslik', '/faol — qayta faollashish', '/yordam — shu ro\'yxatni qayta ko\'rish');
  } else {
    lines.push('Agar ustoz bo\'lsangiz, shu ID raqamni Adminga yuboring — u sizni ustoz sifatida qo\'shadi.', '', "Schreiben yozib saytda tekshirtirgach, /cv buyrug'i orqali o'z natijalaringizni shu yerdan ko'rishingiz mumkin.", "/premium — Premium/Pro obuna sotib olish", '/yordam — buyruqlar ro\'yxatini qayta ko\'rish');
  }
  return lines;
}

bot.onText(/^\/start(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const user = upsertUser(msg.from);
  const payload = match && match[1];

  if(payload && payload.startsWith('verify_')){
    const sessionId = payload.slice('verify_'.length);
    try{
      const member = await bot.getChatMember(CHANNEL_USERNAME, msg.from.id);
      const okStatuses = ['member', 'administrator', 'creator'];
      if(okStatuses.includes(member.status)){
        store.update((data) => {
          if(data.verifySessions[sessionId]){
            data.verifySessions[sessionId].status = 'confirmed';
            data.verifySessions[sessionId].telegram_id = msg.from.id;
          }
        });
        await bot.sendMessage(chatId,
          `✅ Obuna tasdiqlandi!\n\nSizning Telegram ID: ${msg.from.id}\nRol: ${user.role}`,
          { reply_markup: { inline_keyboard: [[{ text: '🌐 Platformaga qaytish', url: SITE_URL }]] } }
        );
      } else {
        await bot.sendMessage(chatId,
          `❌ Siz hali ${CHANNEL_USERNAME} kanaliga obuna bo'lmagansiz.\n` +
          `Avval kanalga qo'shiling, so'ng saytdagi "✅ Tekshirish" tugmasini qayta bosing.`
        );
      }
    } catch(err){
      console.error('getChatMember xatolik:', err.message);
      await bot.sendMessage(chatId, `❌ Tekshirishda xatolik yuz berdi. Birozdan so'ng qayta urinib ko'ring.`);
    }
    return;
  }

  const lines = [
    `Salom, ${msg.from.first_name || ''}! 👋`,
    ``,
    `Sizning Telegram ID: ${msg.from.id}`,
    `Rol: ${user.role}`,
    ''
  ].concat(buildCommandLines(user, msg.from.id));
  bot.sendMessage(chatId, lines.join('\n'), { reply_markup: mainMenuKeyboard(user, msg.from.id) });
});

bot.onText(/^\/yordam$/, (msg) => {
  const user = upsertUser(msg.from);
  const lines = ['📖 Yordam — mavjud buyruqlar:', ''].concat(buildCommandLines(user, msg.from.id));
  bot.sendMessage(msg.chat.id, lines.join('\n'), { reply_markup: mainMenuKeyboard(user, msg.from.id) });
});

bot.onText(/^\/whoami$/, (msg) => {
  const user = upsertUser(msg.from);
  bot.sendMessage(msg.chat.id, `ID: ${msg.from.id}\nRol: ${user.role}`);
});

bot.onText(/^\/addteacher\s+(\d+)(?:\s+(.+))?$/, async (msg, match) => {
  if(!isAdmin(msg.from.id)) return;
  const id = Number(match[1]);
  const name = match[2] ? match[2].trim() : null;
  const before = store.load().users[String(id)];
  const teacher = promoteToTeacher(id, name);
  bot.sendMessage(msg.chat.id, `✅ ${id} endi ustoz${teacher.display_name ? ' — ' + teacher.display_name : ''}. Kalit: ${teacher.teacher_key}`);
  await notifyNewTeacherIfNeeded(before, teacher);
});

bot.onText(/^\/removeteacher\s+(\d+)$/, (msg, match) => {
  if(!isAdmin(msg.from.id)) return;
  const id = Number(match[1]);
  store.update((data) => {
    const key = String(id);
    if(data.users[key]) data.users[key].role = 'student';
  });
  bot.sendMessage(msg.chat.id, `${id} ustozlikdan olib tashlandi.`);
});

function handleTeachersList(chatId, fromId){
  if(!isAdmin(fromId)) return;
  const data = store.load();
  const rows = Object.values(data.users).filter(u => u.role === 'teacher');
  if(rows.length === 0){
    bot.sendMessage(chatId, "Hozircha ustozlar yo'q. /addteacher <id> <Ism Familya> orqali qo'shing yoki /admin panelidan foydalaning.");
    return;
  }
  const text = rows.map(r => `• ${r.display_name || r.first_name || '(nomsiz)'} (@${r.username || '-'}) — ID: ${r.telegram_id}${r.is_paused ? ' — ⏸ band' : ''}`).join('\n');
  bot.sendMessage(chatId, `Ustozlar:\n${text}`);
}
bot.onText(/^\/teachers$/, (msg) => handleTeachersList(msg.chat.id, msg.from.id));

/* ---- Ustoz o'zini vaqtincha "band" qilib qo'yishi — yangi ishlar kelmay turadi (admin baribir oladi) ---- */
async function handleTogglePause(chatId, fromId, pause){
  const data = store.load();
  const user = data.users[String(fromId)];
  if(!user || user.role !== 'teacher'){
    await bot.sendMessage(chatId, "Bu buyruq faqat ustozlar uchun.");
    return;
  }
  store.update((d) => { d.users[String(fromId)].is_paused = pause; });
  const updated = store.load().users[String(fromId)];
  const text = pause
    ? "⏸ Band rejimi yoqildi. Endi o'quvchilar sizni tanlash ro'yxatida ko'rmaydi va yangi ishlar kelmaydi (admin baribir barcha ishlarni oladi).\n\nQayta faollashish uchun: /faol"
    : "✅ Siz endi faolsiz. O'quvchilar sizni yana tanlashi va yangi ishlar kelishi mumkin.";
  await bot.sendMessage(chatId, text, { reply_markup: mainMenuKeyboard(updated, fromId) });
}
bot.onText(/^\/pauza$/, (msg) => handleTogglePause(msg.chat.id, msg.from.id, true));
bot.onText(/^\/faol$/, (msg) => handleTogglePause(msg.chat.id, msg.from.id, false));

/* ================= HTTP API ================= */
const app = express();
app.set('trust proxy', true); // Railway proxy ortida req.ip to'g'ri (X-Forwarded-For) kelishi uchun
app.use(cors());
app.use(express.json({ limit: '2mb' }));

/* express.json() buzuq JSON kelsa xato tashlaydi — buni ham JSON formatida qaytaramiz (default Express HTML sahifa chiqaradi). */
app.use((err, req, res, next) => {
  if(err && err.type === 'entity.parse.failed'){
    return res.status(400).json({ error: "So'rov tanasi yaroqsiz JSON" });
  }
  next(err);
});

/* Har bir so'rovni Railway loglariga yozib boradi — muammo bo'lsa tezda topish uchun. */
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

app.use('/admin', express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.send('Prufungs bot server ishlayapti.');
});

function requireAdmin(req, res, next){
  const pass = req.headers['x-admin-password'] || '';
  if(!ADMIN_PASSWORD){
    return res.status(401).json({ error: 'unauthorized' });
  }
  // Brute-force himoyasi: bir IP dan ketma-ket ko'p noto'g'ri urinishlar vaqtincha bloklanadi
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const attempt = loginAttempts.get(ip);
  if(attempt && attempt.lockedUntil && Date.now() < attempt.lockedUntil){
    return res.status(429).json({ error: "Juda ko'p noto'g'ri urinish. Birozdan so'ng qayta urinib ko'ring." });
  }
  // Taymingga chidamli solishtirish — parol uzunligini/vaqtini bilib olishning oldini oladi
  const passBuf = Buffer.from(pass);
  const realBuf = Buffer.from(ADMIN_PASSWORD);
  const matches = passBuf.length === realBuf.length && crypto.timingSafeEqual(passBuf, realBuf);
  if(!matches){
    const current = loginAttempts.get(ip) || { count: 0, lockedUntil: null };
    current.count++;
    if(current.count >= 8){
      current.lockedUntil = Date.now() + 5 * 60 * 1000; // 5 daqiqaga bloklash
      current.count = 0;
    }
    loginAttempts.set(ip, current);
    return res.status(401).json({ error: 'unauthorized' });
  }
  loginAttempts.delete(ip);
  next();
}

/* ---- Obuna tekshiruvi (deep-link + polling) ---- */
app.post('/api/verify/start', async (req, res) => {
  const sessionId = crypto.randomUUID();
  store.update((data) => {
    data.verifySessions[sessionId] = { status: 'pending', telegram_id: null, created_at: new Date().toISOString() };
  });
  try{
    const me = await bot.getMe();
    res.json({ sessionId, deepLink: `https://t.me/${me.username}?start=verify_${sessionId}` });
  }catch(err){
    console.error('getMe xatolik:', err.message);
    res.status(500).json({ error: 'bot_unavailable' });
  }
});

app.get('/api/verify/status/:sessionId', (req, res) => {
  const data = store.load();
  const session = data.verifySessions[req.params.sessionId];
  if(!session) return res.status(404).json({ status: 'unknown' });
  const age = Date.now() - new Date(session.created_at).getTime();
  if(session.status === 'pending' && age > VERIFY_SESSION_TTL_MS){
    return res.json({ status: 'expired' });
  }
  res.json({ status: session.status, telegramId: session.telegram_id || null });
});

/* ---- Sayt uchun ochiq (auth talab qilmaydigan) ustozlar ro'yxati ---- */
app.get('/api/teachers/public', (req, res) => {
  const data = store.load();
  const teachers = Object.values(data.users)
    .filter(u => u.role === 'teacher' && u.display_name && u.teacher_key && !u.is_paused)
    .map(u => ({ key: u.teacher_key, name: u.display_name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ teachers });
});

/* ---- Sayt uchun: obuna holati va bepul limit qolgan sonini bilish ---- */
app.get('/api/subscription/:telegramId', (req, res) => {
  const sub = getSubscriptionInfo(req.params.telegramId);
  const usage = getWeeklyUsage(req.params.telegramId);
  res.json({
    tier: sub.tier,
    active: sub.active,
    expiresAt: sub.expiresAt,
    weeklyUsed: usage.count,
    weeklyLimit: FREE_WEEKLY_LIMIT,
    botLink: BOT_USERNAME ? `https://t.me/${BOT_USERNAME}` : null
  });
});

/* ---- Sayt uchun: AI tekshiruvdan OLDIN chaqiriladi — limitni tekshiradi va (bepul bo'lsa) sarflaydi ---- */
app.post('/api/usage/check-and-consume', (req, res) => {
  const { studentTelegramId } = req.body || {};
  if(!studentTelegramId){
    // Eski (identifikatsiyasiz) sessiyalar uchun — hozircha ruxsat, lekin sanalmaydi
    return res.json({ allowed: true, tier: 'unknown', remaining: null, botLink: BOT_USERNAME ? `https://t.me/${BOT_USERNAME}` : null });
  }
  const result = checkAndConsumeQuota(studentTelegramId);
  res.json(Object.assign({}, result, { botLink: BOT_USERNAME ? `https://t.me/${BOT_USERNAME}` : null }));
});

/* ---- O'quvchi ishini yuborish: TANLANGAN ustozga + har doim adminga ---- */
app.post('/api/submit', async (req, res) => {
  try{
    const { studentName, studentTelegramId, teacherKey, level, category, taskTitle, text, wordCount, aiScore, aiFeedback } = req.body || {};
    if(!studentName || !text){
      return res.status(400).json({ error: "studentName va text majburiy" });
    }

    // Dublikatni ushlash: bir xil o'quvchi bir xil matnni qisqa vaqt ichida qayta yuborsa
    // (tugmani ikki marta bosish, tarmoq qayta urinishi, yoki bir xil ishni qayta tekshirtirish),
    // ustozga/adminga qayta xabar bormaydi — mavjud yozuv qaytariladi.
    const DUPLICATE_WINDOW_MS = 10 * 60 * 1000; // 10 daqiqa
    const dupData = store.load();
    const now = Date.now();
    const duplicate = dupData.submissions.find((s) => {
      const sameStudent = studentTelegramId
        ? String(s.student_telegram_id) === String(studentTelegramId)
        : s.student_name === String(studentName).slice(0, 200);
      return sameStudent && s.text_content === text && (now - new Date(s.created_at).getTime()) < DUPLICATE_WINDOW_MS;
    });
    if(duplicate){
      return res.json({ ok: true, submissionId: duplicate.id, duplicate: true, notified: 0 });
    }

    const submission = {
      id: null,
      student_name: String(studentName).slice(0, 200),
      student_telegram_id: studentTelegramId || null,
      teacher_key: teacherKey || '',
      level: level || '',
      category: category || '',
      task_title: taskTitle || '',
      text_content: text,
      word_count: wordCount || 0,
      ai_score: aiScore != null ? String(aiScore) : '',
      ai_feedback: aiFeedback || '',
      final_score: null,
      graded_by: null,
      graded_by_id: null,
      graded_at: null,
      created_at: new Date().toISOString()
    };
    store.update((data) => {
      submission.id = data.nextSubmissionId++;
      data.submissions.push(submission);
      if(data.submissions.length > 500) data.submissions = data.submissions.slice(-500);
    });

    const data = store.load();
    const targetTeacher = teacherKey
      ? Object.values(data.users).find(u => u.role === 'teacher' && u.teacher_key === teacherKey)
      : null;
    const teacherIsUsable = targetTeacher && !targetTeacher.is_paused;

    const recipients = [];
    if(teacherIsUsable) recipients.push(targetTeacher.telegram_id);
    if(ADMIN_TELEGRAM_ID && Number(ADMIN_TELEGRAM_ID) !== (teacherIsUsable ? targetTeacher.telegram_id : null)){
      recipients.push(Number(ADMIN_TELEGRAM_ID));
    }

    // O'quvchining so'nggi faollik vaqtini yangilaymiz (kunlik eslatma shu asosda ishlaydi)
    if(submission.student_telegram_id){
      store.update((d) => {
        const key = String(submission.student_telegram_id);
        if(d.users[key]) d.users[key].last_submission_at = submission.created_at;
      });
    }

    const teacherLine = targetTeacher
      ? `\n👨‍🏫 Ustoz: ${targetTeacher.display_name}${targetTeacher.is_paused ? ' (⏸ band edi — faqat sizga yuborildi)' : ''}`
      : `\n👨‍🏫 Ustoz: tanlanmagan`;
    const header = `📝 Yangi Schreiben ishi\n\n👤 ${submission.student_name}${teacherLine}\n📚 Daraja: ${(submission.level || '').toUpperCase()}${submission.category ? ' / ' + submission.category : ''}\n📌 Mavzu: ${submission.task_title || '-'}\n🔢 So'zlar soni: ${submission.word_count}`;
    const scoreLine = submission.ai_score ? `\n⭐ AI bali: ${submission.ai_score}/100` : '';
    const feedbackBlock = submission.ai_feedback ? `\n\n🧾 AI tekshiruvi:\n${submission.ai_feedback}` : '';
    const textBlock = `\n\n✍️ Matn:\n${submission.text_content}`;
    const fullMessage = header + scoreLine + feedbackBlock + textBlock;

    const CHUNK = 3500;
    const chunks = [];
    for(let i = 0; i < fullMessage.length; i += CHUNK){
      chunks.push(fullMessage.slice(i, i + CHUNK));
    }

    const gradeKeyboard = {
      inline_keyboard: [[
        { text: `✅ AI bali (${submission.ai_score || '-'})`, callback_data: `acceptai_${submission.id}` },
        { text: '✏️ Ball kiritish', callback_data: `enterscore_${submission.id}` }
      ]]
    };

    let notified = 0;
    for(const chatId of recipients){
      for(let i = 0; i < chunks.length; i++){
        const isLast = i === chunks.length - 1;
        try{
          await bot.sendMessage(chatId, chunks[i], isLast ? { reply_markup: gradeKeyboard } : undefined);
        }catch(err){
          console.error(`sendMessage xatolik (${chatId}):`, err.message);
        }
      }
      notified++;
    }

    res.json({ ok: true, submissionId: submission.id, notified });
  }catch(err){
    console.error('/api/submit xatolik:', err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Server xatosi, birozdan so'ng qayta urinib ko'ring." });
  }
});

/* ---- Ball tugmalari: "AI bali bilan qabul qilish" yoki "Ball kiritish" ---- */
bot.on('callback_query', async (query) => {
  const data = query.data || '';
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  if(data.startsWith('buytariff_')){
    const tariffKey = data.slice('buytariff_'.length);
    const tariff = TARIFFS[tariffKey];
    if(!tariff){ await bot.answerCallbackQuery(query.id, { text: 'Noma\'lum tarif' }); return; }
    const settings = getSettings();
    const price = tariffPrice(tariffKey);
    if(!settings.cardNumber){
      await bot.answerCallbackQuery(query.id, { text: "To'lov hali sozlanmagan, admin bilan bog'laning", show_alert: true });
      return;
    }
    pendingPayment.set(chatId, tariffKey);
    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(chatId,
      `💳 <b>${tariff.label}</b>\n\nQuyidagi kartaga <b>${price.toLocaleString('ru-RU')} so'm</b> o'tkazing:\n\n` +
      `Karta: <code>${settings.cardNumber}</code>\nEgasi: ${settings.cardHolder || '-'}\n\n` +
      `To'lovni amalga oshirgach, chekning skrinshotini (rasm sifatida) shu yerga yuboring. Admin tez orada tasdiqlaydi.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  if(data.startsWith('payconfirm_') || data.startsWith('payreject_')){
    if(!isAdmin(query.from.id)){
      await bot.answerCallbackQuery(query.id, { text: 'Faqat admin uchun', show_alert: true });
      return;
    }
    const isConfirm = data.startsWith('payconfirm_');
    const reqId = Number(data.slice(isConfirm ? 'payconfirm_'.length : 'payreject_'.length));
    const payData = store.load();
    const payReq = payData.paymentRequests.find(p => p.id === reqId);
    if(!payReq){ await bot.answerCallbackQuery(query.id, { text: 'Topilmadi' }); return; }
    if(payReq.status !== 'pending'){
      await bot.answerCallbackQuery(query.id, { text: 'Bu so\'rov allaqachon ko\'rib chiqilgan' });
      return;
    }

    if(isConfirm){
      const granted = grantSubscription(payReq.student_telegram_id, payReq.tariff_key);
      store.update((d) => { const p = d.paymentRequests.find(x => x.id === reqId); if(p) p.status = 'confirmed'; });
      await bot.answerCallbackQuery(query.id, { text: 'Tasdiqlandi' });
      try{
        await bot.editMessageCaption(
          `✅ TASDIQLANDI\n\n${TARIFFS[payReq.tariff_key].label} — ${payReq.student_name} (ID: ${payReq.student_telegram_id})`,
          { chat_id: chatId, message_id: messageId }
        );
      }catch(e){}
      if(granted){
        const expiryStr = new Date(granted.expiresAt).toLocaleDateString('uz-UZ');
        bot.sendMessage(payReq.student_telegram_id,
          `✅ To'lovingiz tasdiqlandi!\n\n🎉 Sizga <b>${granted.tier === 'pro' ? 'Pro' : 'Premium'}</b> obuna faollashtirildi.\nAmal qilish muddati: <b>${expiryStr}</b> gacha.`,
          { parse_mode: 'HTML' }
        ).catch((err) => console.error('obuna xabarini yuborishda xatolik:', err.message));
      }
    } else {
      store.update((d) => { const p = d.paymentRequests.find(x => x.id === reqId); if(p) p.status = 'rejected'; });
      await bot.answerCallbackQuery(query.id, { text: 'Rad etildi' });
      try{
        await bot.editMessageCaption(
          `❌ RAD ETILDI\n\n${TARIFFS[payReq.tariff_key].label} — ${payReq.student_name} (ID: ${payReq.student_telegram_id})`,
          { chat_id: chatId, message_id: messageId }
        );
      }catch(e){}
      bot.sendMessage(payReq.student_telegram_id,
        "❌ To'lovingiz tasdiqlanmadi. Iltimos, chekni tekshirib qayta urinib ko'ring yoki admin bilan bog'laning."
      ).catch((err) => console.error('rad etish xabarini yuborishda xatolik:', err.message));
    }
    return;
  }

  if(data.startsWith('acceptai_')){
    const submissionId = Number(data.slice('acceptai_'.length));
    const result = gradeSubmission(submissionId, null, query.from);
    if(result.ok){
      await bot.answerCallbackQuery(query.id, { text: `Ball saqlandi: ${result.score}/100` });
      try{
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [[{ text: `${scoreEmoji(result.score)} Baholandi: ${result.score}/100 — o'zgartirish`, callback_data: `enterscore_${submissionId}` }]] },
          { chat_id: chatId, message_id: messageId }
        );
      }catch(e){ /* xabar allaqachon eskirgan bo'lishi mumkin */ }
      notifyStudentOfScore(submissionId);
      askForComment(chatId, submissionId);
    } else {
      await bot.answerCallbackQuery(query.id, { text: result.error, show_alert: true });
    }
    return;
  }

  if(data.startsWith('enterscore_')){
    const submissionId = Number(data.slice('enterscore_'.length));
    pendingScoreEntry.set(chatId, { submissionId, messageId });
    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(chatId, `✏️ Ushbu ish uchun ballni raqam bilan yozib yuboring (0-100):`, { reply_markup: { force_reply: true } });
    return;
  }

  if(data.startsWith('addcomment_')){
    const submissionId = Number(data.slice('addcomment_'.length));
    pendingCommentEntry.set(chatId, submissionId);
    await bot.answerCallbackQuery(query.id);
    try{ await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }); }catch(e){}
    await bot.sendMessage(chatId, "✏️ Izohingizni yozib yuboring — o'quvchiga shu matn Telegram orqali yetkaziladi:", { reply_markup: { force_reply: true } });
    return;
  }

  if(data.startsWith('skipcomment_')){
    await bot.answerCallbackQuery(query.id, { text: 'OK' });
    try{ await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }); }catch(e){}
    return;
  }

  if(data === 'menu_jadval'){
    await bot.answerCallbackQuery(query.id);
    handleJadval(chatId, query.from.id);
    return;
  }
  if(data === 'menu_reyting'){
    await bot.answerCallbackQuery(query.id);
    handleReyting(chatId, query.from.id);
    return;
  }
  if(data === 'menu_export'){
    await bot.answerCallbackQuery(query.id);
    handleExport(chatId, query.from.id);
    return;
  }
  if(data === 'menu_teachers'){
    await bot.answerCallbackQuery(query.id);
    handleTeachersList(chatId, query.from.id);
    return;
  }
  if(data === 'menu_cv'){
    await bot.answerCallbackQuery(query.id);
    handleCv(chatId, query.from.id);
    return;
  }
  if(data === 'menu_premium'){
    await bot.answerCallbackQuery(query.id);
    const rows = Object.keys(TARIFFS).map((key) => [{
      text: `${TARIFFS[key].label} — ${tariffPrice(key).toLocaleString('ru-RU')} so'm`,
      callback_data: `buytariff_${key}`
    }]);
    bot.sendMessage(chatId,
      "💎 Obuna tariflari:\n\nPremium — joriy kitob (ARENA) + cheksiz AI tekshiruv.\nPro — barcha kitoblar + cheksiz AI tekshiruv.\n\nTarifni tanlang:",
      { reply_markup: { inline_keyboard: rows } }
    );
    return;
  }
  if(data === 'menu_toggle_pause'){
    const dataStore = store.load();
    const u = dataStore.users[String(query.from.id)];
    if(!u || u.role !== 'teacher'){
      await bot.answerCallbackQuery(query.id, { text: 'Faqat ustozlar uchun', show_alert: true });
      return;
    }
    await bot.answerCallbackQuery(query.id);
    await handleTogglePause(chatId, query.from.id, !u.is_paused);
    return;
  }

  if(data === 'broadcast_confirm'){
    const pending = pendingBroadcast.get(chatId);
    if(!pending){
      await bot.answerCallbackQuery(query.id, { text: "Muddati o'tgan, qayta /xabar yozing" });
      return;
    }
    pendingBroadcast.delete(chatId);
    await bot.answerCallbackQuery(query.id, { text: 'Yuborilmoqda...' });
    try{ await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }); }catch(e){}
    let sent = 0;
    for(const id of pending.ids){
      try{
        await bot.sendMessage(id, `📢 Xabar:\n\n${pending.text}`);
        sent++;
      }catch(err){
        console.error(`broadcast xatolik (${id}):`, err.message);
      }
      await new Promise((r) => setTimeout(r, 40)); // Telegram flood-limitidan qochish uchun kichik pauza
    }
    await bot.sendMessage(chatId, `✅ Xabar yuborildi: ${sent}/${pending.ids.length} ta o'quvchiga.`);
    return;
  }
  if(data === 'broadcast_cancel'){
    pendingBroadcast.delete(chatId);
    await bot.answerCallbackQuery(query.id, { text: 'Bekor qilindi' });
    try{ await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }); }catch(e){}
    return;
  }

  if(data === 'clear_confirm'){
    if(!isAdmin(query.from.id)){
      await bot.answerCallbackQuery(query.id, { text: 'Faqat admin uchun', show_alert: true });
      return;
    }
    if(!pendingClear.get(chatId)){
      await bot.answerCallbackQuery(query.id, { text: "Muddati o'tgan, qayta /tozalash yozing" });
      return;
    }
    pendingClear.delete(chatId);
    const removed = store.update((d) => {
      const n = d.submissions.length;
      d.submissions = [];
      return n;
    });
    await bot.answerCallbackQuery(query.id, { text: "O'chirildi" });
    try{ await bot.editMessageText(`🗑 ${removed} ta yozuv o'chirildi.`, { chat_id: chatId, message_id: messageId }); }catch(e){}
    return;
  }
  if(data === 'clear_cancel'){
    pendingClear.delete(chatId);
    await bot.answerCallbackQuery(query.id, { text: 'Bekor qilindi' });
    try{ await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }); }catch(e){}
    return;
  }

  await bot.answerCallbackQuery(query.id);
});

/* ---- "Ball kiritish" bosilgach kutilayotgan matnli javobni, yoki izoh matnini qabul qiladi ---- */
bot.on('message', async (msg) => {
  // To'lov skrinshoti (rasm) kelsa
  if(msg.photo && msg.photo.length > 0){
    const tariffKey = pendingPayment.get(msg.chat.id);
    if(!tariffKey) return; // kutilmagan rasm — e'tiborsiz qoldiramiz
    pendingPayment.delete(msg.chat.id);
    const tariff = TARIFFS[tariffKey];
    const price = tariffPrice(tariffKey);
    const user = upsertUser(msg.from);
    const fileId = msg.photo[msg.photo.length - 1].file_id; // eng katta o'lchamdagi versiyasi

    const reqRecord = store.update((data) => {
      const rec = {
        id: data.nextPaymentRequestId++,
        student_telegram_id: msg.from.id,
        student_name: user.display_name || msg.from.first_name || String(msg.from.id),
        tariff_key: tariffKey,
        amount: price,
        photo_file_id: fileId,
        status: 'pending',
        created_at: new Date().toISOString()
      };
      data.paymentRequests.push(rec);
      return rec;
    });

    bot.sendMessage(msg.chat.id, "✅ Chek qabul qilindi. Admin tez orada tekshirib, obunangizni faollashtiradi.");

    if(ADMIN_TELEGRAM_ID){
      bot.sendPhoto(Number(ADMIN_TELEGRAM_ID), fileId, {
        caption: `💳 Yangi to'lov so'rovi #${reqRecord.id}\n\n👤 ${reqRecord.student_name} (ID: ${msg.from.id})\n📦 ${tariff.label}\n💰 ${price.toLocaleString('ru-RU')} so'm`,
        reply_markup: { inline_keyboard: [[
          { text: '✅ Tasdiqlash', callback_data: `payconfirm_${reqRecord.id}` },
          { text: '❌ Rad etish', callback_data: `payreject_${reqRecord.id}` }
        ]] }
      }).catch((err) => console.error('adminga chek yuborishda xatolik:', err.message));
    }
    return;
  }

  if(!msg.text || msg.text.startsWith('/')) return; // buyruqlar alohida onText orqali ishlaydi

  const pendingComment = pendingCommentEntry.get(msg.chat.id);
  if(pendingComment){
    pendingCommentEntry.delete(msg.chat.id);
    const comment = msg.text.trim().slice(0, 1000);
    const sub = store.update((data) => {
      const s = data.submissions.find(x => x.id === pendingComment);
      if(s) s.teacher_comment = comment;
      return s;
    });
    bot.sendMessage(msg.chat.id, '✅ Izoh saqlandi.');
    if(sub && sub.student_telegram_id){
      bot.sendMessage(sub.student_telegram_id, `✉️ Ustozingizdan izoh (${sub.task_title || 'Schreiben'}):\n\n${comment}`)
        .catch((err) => console.error('izohni o\'quvchiga yuborishda xatolik:', err.message));
    }
    return;
  }

  const pending = pendingScoreEntry.get(msg.chat.id);
  if(!pending) return;

  const num = Number(msg.text.trim().replace(',', '.'));
  if(!Number.isFinite(num) || num < 0 || num > 100){
    bot.sendMessage(msg.chat.id, "Iltimos, 0 dan 100 gacha bo'lgan son yuboring (masalan: 78).");
    return;
  }
  pendingScoreEntry.delete(msg.chat.id);
  const result = gradeSubmission(pending.submissionId, num, msg.from);
  if(result.ok){
    bot.sendMessage(msg.chat.id, `✅ Ball saqlandi: ${result.score}/100`);
    try{
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [[{ text: `${scoreEmoji(result.score)} Baholandi: ${result.score}/100 — o'zgartirish`, callback_data: `enterscore_${pending.submissionId}` }]] },
        { chat_id: msg.chat.id, message_id: pending.messageId }
      );
    }catch(e){ /* xabar allaqachon eskirgan bo'lishi mumkin */ }
    notifyStudentOfScore(pending.submissionId);
    askForComment(msg.chat.id, pending.submissionId);
  } else {
    bot.sendMessage(msg.chat.id, result.error);
  }
});

/* ---- Ustoz/admin uchun jadval va CSV eksport ---- */
function rowsForRequester(fromId){
  const data = store.load();
  if(isAdmin(fromId)) return { rows: data.submissions, scope: 'Barcha markazlar' };
  const user = data.users[String(fromId)];
  if(user && user.role === 'teacher' && user.teacher_key){
    return { rows: data.submissions.filter(s => s.teacher_key === user.teacher_key), scope: user.display_name || 'Siz' };
  }
  return null;
}

/* ---- /xabar — o'quvchilarga ogohlantirish/xabar yuborish (tasdiqlash bilan) ---- */
function getBroadcastAudience(fromId){
  const data = store.load();
  if(isAdmin(fromId)){
    const ids = Object.values(data.users).filter(u => u.role === 'student').map(u => u.telegram_id);
    return { ids, scope: "Barcha o'quvchilar" };
  }
  const me = data.users[String(fromId)];
  if(me && me.role === 'teacher' && me.teacher_key){
    const idSet = new Set();
    data.submissions.forEach(s => {
      if(s.teacher_key === me.teacher_key && s.student_telegram_id) idSet.add(Number(s.student_telegram_id));
    });
    return { ids: Array.from(idSet), scope: `${me.display_name || 'Sizning'} o'quvchilaringiz` };
  }
  return null;
}
bot.onText(/^\/xabar(?:\s+([\s\S]+))?$/, (msg, match) => {
  const text = match && match[1] ? match[1].trim() : '';
  if(!text){
    bot.sendMessage(msg.chat.id, "Xabar matnini yozing, masalan:\n/xabar Ertaga dars bo'lmaydi.");
    return;
  }
  const audience = getBroadcastAudience(msg.from.id);
  if(!audience){
    bot.sendMessage(msg.chat.id, "Bu buyruq faqat ustoz yoki admin uchun.");
    return;
  }
  if(audience.ids.length === 0){
    bot.sendMessage(msg.chat.id, "Hozircha xabar yuborish uchun hech kim topilmadi (o'quvchilar botga hali /start bosmagan yoki hali sizga bog'lanmagan).");
    return;
  }
  pendingBroadcast.set(msg.chat.id, { text, ids: audience.ids, scope: audience.scope });
  bot.sendMessage(msg.chat.id,
    `📢 Quyidagi xabar ${audience.ids.length} ta o'quvchiga (${audience.scope}) yuboriladi:\n\n"${text}"\n\nTasdiqlaysizmi?`,
    { reply_markup: { inline_keyboard: [[
      { text: '✅ Ha, yubor', callback_data: 'broadcast_confirm' },
      { text: '❌ Bekor qilish', callback_data: 'broadcast_cancel' }
    ]] } }
  );
});

/* ---- /tozalash — jadvalni (barcha natijalarni) o'chirish, faqat admin, tasdiqlash bilan ---- */
bot.onText(/^\/tozalash$/, (msg) => {
  if(!isAdmin(msg.from.id)) return;
  const data = store.load();
  const count = data.submissions.length;
  if(count === 0){ bot.sendMessage(msg.chat.id, "Jadval allaqachon bo'sh."); return; }
  pendingClear.set(msg.chat.id, true);
  bot.sendMessage(msg.chat.id,
    `⚠️ Diqqat! Bu ${count} ta yozuvni (BARCHA natijalarni, barcha markazlar bo'yicha) butunlay o'chiradi. Bu amalni ortga qaytarib bo'lmaydi.\n\nRostdan ham davom etasizmi?`,
    { reply_markup: { inline_keyboard: [[
      { text: "🗑 Ha, hammasini o'chir", callback_data: 'clear_confirm' },
      { text: '❌ Bekor qilish', callback_data: 'clear_cancel' }
    ]] } }
  );
});

/* ---- /tahrirla <id> <ball> — mavjud yozuvning ballini tuzatish ---- */
bot.onText(/^\/tahrirla\s+(\d+)\s+(\d+(?:[.,]\d+)?)$/, (msg, match) => {
  const id = Number(match[1]);
  const newScore = Math.round(Number(match[2].replace(',', '.')));
  if(!Number.isFinite(newScore) || newScore < 0 || newScore > 100){
    bot.sendMessage(msg.chat.id, "Ball 0 dan 100 gacha bo'lgan son bo'lishi kerak.");
    return;
  }
  const data = store.load();
  const sub = data.submissions.find(s => s.id === id);
  if(!sub){ bot.sendMessage(msg.chat.id, `#${id} raqamli ish topilmadi.`); return; }

  const me = data.users[String(msg.from.id)];
  const isOwnerTeacher = me && me.role === 'teacher' && me.teacher_key === sub.teacher_key;
  if(!isAdmin(msg.from.id) && !isOwnerTeacher){
    bot.sendMessage(msg.chat.id, "Bu ishni faqat admin yoki shu ishga tayinlangan ustoz tahrirlashi mumkin.");
    return;
  }

  const oldScore = sub.final_score;
  store.update((d) => {
    const s = d.submissions.find(x => x.id === id);
    s.final_score = newScore;
    s.graded_by_id = msg.from.id;
    s.graded_at = new Date().toISOString();
  });
  bot.sendMessage(msg.chat.id, `✅ #${id} ish bali yangilandi: ${oldScore != null ? oldScore + ' → ' : ''}${newScore}/100`);
  notifyStudentOfScore(id);
});

/* ---- /premium — obuna sotib olish oqimi ---- */
bot.onText(/^\/premium$/, (msg) => {
  const settings = getSettings();
  const rows = Object.keys(TARIFFS).map((key) => [{
    text: `${TARIFFS[key].label} — ${tariffPrice(key).toLocaleString('ru-RU')} so'm`,
    callback_data: `buytariff_${key}`
  }]);
  bot.sendMessage(msg.chat.id,
    "💎 Obuna tariflari:\n\nPremium — joriy kitob (ARENA) + cheksiz AI tekshiruv.\nPro — barcha kitoblar + cheksiz AI tekshiruv.\n\nTarifni tanlang:",
    { reply_markup: { inline_keyboard: rows } }
  );
});

/* ---- O'quvchi uchun: FAQAT o'zining natijalari (Telegram orqali obuna tekshiruvidan o'tganlar uchun) ---- */
bot.onText(/^\/cv$/, (msg) => handleCv(msg.chat.id, msg.from.id));
function handleCv(chatId, fromId){
  const data = store.load();
  const rows = data.submissions.filter(s => s.student_telegram_id && String(s.student_telegram_id) === String(fromId));
  if(rows.length === 0){
    bot.sendMessage(chatId,
      "Sizda hali yuborilgan ish topilmadi.\n\n" +
      "Eslatma: bu buyruq faqat saytda Telegram orqali obunani tasdiqlab (✅ Tekshirish tugmasi) Schreiben yozgan ishlar uchun ishlaydi. " +
      "Agar avvalroq obunani tasdiqlagan bo'lsangiz-u, hali natija ko'rmayotgan bo'lsangiz — saytda birinchi yozuvingizni yuboring, keyingi safar shu yerda ko'rinadi."
    );
    return;
  }
  const sorted = rows.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const graded = sorted.filter(r => r.final_score != null);
  const avg = graded.length ? Math.round(graded.reduce((sum, r) => sum + r.final_score, 0) / graded.length) : null;

  const lines = sorted.slice(0, 20).map(r => {
    const d = new Date(r.created_at);
    const dateStr = `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}`;
    let scoreText;
    if(r.final_score != null){
      scoreText = `${scoreEmoji(r.final_score)} ${r.final_score}/100`;
    } else if(r.ai_score){
      scoreText = `⏳ ${r.ai_score}/100 (AI, ustoz hali tasdiqlamagan)`;
    } else {
      scoreText = '⏳ hali baholanmagan';
    }
    const commentLine = r.teacher_comment ? `\n   💬 ${r.teacher_comment}` : '';
    return `${dateStr} — ${r.level}${r.category ? '/' + r.category : ''} — ${r.task_title || '-'} — ${scoreText}${commentLine}`;
  });

  const header = `📋 Sizning natijalaringiz (${rows.length} ta ish)` + (avg != null ? `\nO'rtacha ball: ${avg}/100 (${graded.length} ta baholangan)` : '');
  bot.sendMessage(chatId, `${header}\n\n${lines.join('\n')}`);
}

bot.onText(/^\/reyting$/, (msg) => handleReyting(msg.chat.id, msg.from.id));
function handleReyting(chatId, fromId){
  const access = rowsForRequester(fromId);
  if(!access){ bot.sendMessage(chatId, "Bu buyruq faqat ustoz yoki admin uchun."); return; }
  const graded = access.rows.filter(r => r.final_score != null);
  if(graded.length === 0){ bot.sendMessage(chatId, "Hali baholangan ish yo'q."); return; }

  const byStudent = {};
  graded.forEach(r => {
    const key = r.student_name.trim().toLowerCase();
    if(!byStudent[key]) byStudent[key] = { name: r.student_name, scores: [] };
    byStudent[key].scores.push(r.final_score);
  });
  const ranking = Object.values(byStudent)
    .map(s => ({
      name: s.name,
      avg: Math.round(s.scores.reduce((a, b) => a + b, 0) / s.scores.length),
      count: s.scores.length,
      best: Math.max(...s.scores)
    }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 15);

  const medals = ['🥇', '🥈', '🥉'];
  const lines = ranking.map((s, i) => `${medals[i] || (i + 1) + '.'} ${s.name} — o'rtacha ${s.avg}/100 (${s.count} ta ish, eng yaxshisi ${s.best})`);
  bot.sendMessage(chatId, `🏆 ${access.scope} — reyting:\n\n${lines.join('\n')}`);
}

bot.onText(/^\/jadval$/, (msg) => handleJadval(msg.chat.id, msg.from.id));
function handleJadval(chatId, fromId){
  const access = rowsForRequester(fromId);
  if(!access){ bot.sendMessage(chatId, "Bu buyruq faqat ustoz yoki admin uchun."); return; }
  const graded = access.rows
    .filter(r => r.final_score != null)
    .sort((a, b) => new Date(b.graded_at) - new Date(a.graded_at))
    .slice(0, 15);
  if(graded.length === 0){
    bot.sendMessage(chatId, "Hali baholangan ish yo'q.");
    return;
  }
  const lines = graded.map(r => {
    const d = new Date(r.graded_at);
    const dateStr = `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    return `${scoreEmoji(r.final_score)} ${dateStr} — ${r.student_name} — ${r.level}${r.category ? '/' + r.category : ''} — ${r.final_score}/100`;
  });
  bot.sendMessage(chatId, `📊 ${access.scope} — so'nggi baholangan ishlar:\n\n${lines.join('\n')}\n\nTo'liq jadval (Excel/CSV) uchun: /export`);
}

bot.onText(/^\/export$/, (msg) => handleExport(msg.chat.id, msg.from.id));
async function handleExport(chatId, fromId){
  const access = rowsForRequester(fromId);
  if(!access){ bot.sendMessage(chatId, "Bu buyruq faqat ustoz yoki admin uchun."); return; }
  if(access.rows.length === 0){
    bot.sendMessage(chatId, "Hozircha ishlar yo'q.");
    return;
  }
  const csv = '\uFEFF' + toCSV(access.rows); // BOM — Excel'da o'zbekcha harflar to'g'ri ochilishi uchun
  const buffer = Buffer.from(csv, 'utf8');
  try{
    await bot.sendDocument(chatId, buffer, {}, { filename: `natijalar_${Date.now()}.csv`, contentType: 'text/csv' });
  }catch(err){
    console.error('sendDocument xatolik:', err.message);
    bot.sendMessage(chatId, "Faylni yuborishda xatolik yuz berdi.");
  }
}

/* ================= ADMIN API (/admin panel shu yerga murojaat qiladi) ================= */
app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const data = store.load();
  const users = Object.values(data.users);
  const teachers = users
    .filter(u => u.role === 'teacher')
    .map(u => ({ telegram_id: u.telegram_id, username: u.username, first_name: u.first_name, display_name: u.display_name || '', teacher_key: u.teacher_key, is_paused: !!u.is_paused }));
  const candidates = users
    .filter(u => u.role === 'student')
    .map(u => ({ telegram_id: u.telegram_id, username: u.username, first_name: u.first_name }));
  const pendingPayments = data.paymentRequests.filter(p => p.status === 'pending').length;
  const activeSubscribers = users.filter(u => {
    const sub = getSubscriptionInfo(u.telegram_id);
    return sub.active;
  }).length;
  res.json({ teachers, candidates, submissionsCount: data.submissions.length, pendingPayments, activeSubscribers });
});

/* ---- To'lov sozlamalari: karta, egasi, narxlar — admin panelidan tahrirlanadi ---- */
app.get('/api/admin/settings', requireAdmin, (req, res) => {
  res.json(getSettings());
});
app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const { cardNumber, cardHolder, prices } = req.body || {};
  const updated = store.update((data) => {
    data.settings = data.settings || {};
    if(cardNumber != null) data.settings.cardNumber = String(cardNumber).trim().slice(0, 40);
    if(cardHolder != null) data.settings.cardHolder = String(cardHolder).trim().slice(0, 100);
    if(prices && typeof prices === 'object'){
      data.settings.prices = Object.assign({}, data.settings.prices, {
        premium_1m: Number(prices.premium_1m) || DEFAULT_SETTINGS.prices.premium_1m,
        premium_3m: Number(prices.premium_3m) || DEFAULT_SETTINGS.prices.premium_3m,
        pro_1m: Number(prices.pro_1m) || DEFAULT_SETTINGS.prices.pro_1m
      });
    }
    return data.settings;
  });
  res.json({ ok: true, settings: getSettings() });
});

app.post('/api/admin/teachers', requireAdmin, async (req, res) => {
  const { telegramId, displayName } = req.body || {};
  if(!telegramId || !displayName){
    return res.status(400).json({ error: 'telegramId va displayName kerak' });
  }
  if(!/^\d+$/.test(String(telegramId))){
    return res.status(400).json({ error: "telegramId faqat raqamlardan iborat bo'lishi kerak" });
  }
  const before = store.load().users[String(telegramId)];
  const teacher = promoteToTeacher(telegramId, String(displayName).trim().slice(0, 100));
  res.json({ ok: true, teacher });
  await notifyNewTeacherIfNeeded(before, teacher);
});

app.patch('/api/admin/teachers/:id', requireAdmin, (req, res) => {
  const { displayName } = req.body || {};
  if(!displayName) return res.status(400).json({ error: 'displayName kerak' });
  store.update((data) => {
    const key = String(req.params.id);
    if(data.users[key]) data.users[key].display_name = String(displayName).trim();
  });
  res.json({ ok: true });
});

app.delete('/api/admin/teachers/:id', requireAdmin, (req, res) => {
  store.update((data) => {
    const key = String(req.params.id);
    if(data.users[key]) data.users[key].role = 'student';
  });
  res.json({ ok: true });
});

app.get('/api/admin/export.csv', requireAdmin, (req, res) => {
  const data = store.load();
  const csv = '\uFEFF' + toCSV(data.submissions); // BOM — Excel'da o'zbekcha harflar to'g'ri ochilishi uchun
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="natijalar_${Date.now()}.csv"`);
  res.send(csv);
});

/* API yo'llaridan tashqarisiga tushgan so'rovlar uchun toza JSON 404 (Express'ning standart HTML sahifasi o'rniga). */
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Bunday API yo\'li topilmadi' });
});

/* So'nggi umumiy xato ushlagich — biror route ichida kutilmagan xato tashlansa ham server yiqilmaydi. */
app.use((err, req, res, next) => {
  console.error('Express xatolik:', err && err.stack ? err.stack : err);
  if(res.headersSent) return next(err);
  res.status(500).json({ error: 'Server xatosi' });
});

/* Eskirgan tekshiruv sessiyalarini vaqti-vaqti bilan tozalaydi (fayl cheksiz o'smasligi uchun). */
setInterval(() => {
  store.update((data) => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24 soatdan eski
    Object.keys(data.verifySessions).forEach((id) => {
      const s = data.verifySessions[id];
      if(new Date(s.created_at).getTime() < cutoff) delete data.verifySessions[id];
    });
  });
}, 60 * 60 * 1000); // har soatda

/* ================= FAOLLIK ESLATMASI =================
   Botga /start bosgan, lekin bir necha kundan beri Schreiben yubormagan o'quvchilarga
   eslatma yuboradi. Bir foydalanuvchiga kuniga faqat bir marta yuboriladi. */
const REMINDER_THRESHOLD_MS = 2 * 24 * 60 * 60 * 1000; // 2 kun faollik bo'lmasa eslatiladi
const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000; // bir foydalanuvchiga kunига faqat 1 marta

async function sendInactivityReminders(){
  const data = store.load();
  const now = Date.now();
  const toRemind = Object.values(data.users).filter((u) => {
    if(u.role !== 'student') return false;
    const lastActivity = u.last_submission_at ? new Date(u.last_submission_at).getTime() : new Date(u.created_at).getTime();
    if(now - lastActivity < REMINDER_THRESHOLD_MS) return false;
    if(u.last_reminder_sent_at && now - new Date(u.last_reminder_sent_at).getTime() < REMINDER_COOLDOWN_MS) return false;
    return true;
  });

  for(const u of toRemind){
    try{
      await bot.sendMessage(u.telegram_id,
        `👋 Salom${u.first_name ? ', ' + u.first_name : ''}! Bir necha kundan beri Schreiben yozmadingiz.\n\n` +
        `Har kuni bir nechta daqiqa mashq qilish katta farq qiladi — saytga kirib bitta mavzu yozib ko'ring! ✍️`
      );
      store.update((d) => {
        const key = String(u.telegram_id);
        if(d.users[key]) d.users[key].last_reminder_sent_at = new Date().toISOString();
      });
    }catch(err){
      console.error(`eslatma yuborishda xatolik (${u.telegram_id}):`, err.message);
    }
  }
  if(toRemind.length) console.log(`Faollik eslatmasi yuborildi: ${toRemind.length} ta foydalanuvchiga`);
}

setInterval(sendInactivityReminders, 12 * 60 * 60 * 1000); // har 12 soatda tekshiradi
setTimeout(sendInactivityReminders, 2 * 60 * 1000); // server ishga tushgach 2 daqiqadan keyin birinchi tekshiruv

app.listen(PORT, () => {
  console.log(`HTTP server ${PORT} portda ishga tushdi. DB: ${store.DB_PATH}`);
});
