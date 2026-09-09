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

function isAdmin(telegramId){
  return ADMIN_TELEGRAM_ID && String(telegramId) === String(ADMIN_TELEGRAM_ID);
}

function genTeacherKey(){
  return crypto.randomBytes(5).toString('hex');
}

/* Ball tugmasi bosilganda "endi javob kutilmoqda" holatini saqlaydi: chatId -> {submissionId, messageId} */
const pendingScoreEntry = new Map();

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

function csvEscape(v){
  return `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
}
function toCSV(rows){
  const header = ['ID', 'Sana', 'Talaba', 'Daraja/Bo\'lim', 'Toifa', 'Mavzu', 'Ball', 'Baholadi', 'Baholangan vaqt'];
  const lines = [header.map(csvEscape).join(',')];
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
      r.graded_at || ''
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
          `✅ Obuna tasdiqlandi! Endi saytga qaytib davom etishingiz mumkin.\n\n` +
          `Sizning Telegram ID: ${msg.from.id}\nRol: ${user.role}`
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
    `Rol: ${user.role}`
  ];
  if(isAdmin(msg.from.id)){
    lines.push('', 'Siz adminsiz. Buyruqlar:', '/addteacher <id> <Ism Familya> — ustoz qo\'shish', '/removeteacher <id> — ustozni olib tashlash', '/teachers — ustozlar ro\'yxati', '', 'Yoki /admin panelidan foydalaning.');
  } else if(user.role === 'teacher'){
    lines.push('', `Siz ustoz sifatida ro'yxatdan o'tgansiz${user.display_name ? ' (' + user.display_name + ')' : ''}. Sizni tanlagan o'quvchilarning Schreiben ishlari shu yerga keladi.`);
  } else {
    lines.push('', 'Agar ustoz bo\'lsangiz, shu ID raqamni Adminga yuboring — u sizni ustoz sifatida qo\'shadi.');
  }
  bot.sendMessage(chatId, lines.join('\n'));
});

bot.onText(/^\/whoami$/, (msg) => {
  const user = upsertUser(msg.from);
  bot.sendMessage(msg.chat.id, `ID: ${msg.from.id}\nRol: ${user.role}`);
});

bot.onText(/^\/addteacher\s+(\d+)(?:\s+(.+))?$/, (msg, match) => {
  if(!isAdmin(msg.from.id)) return;
  const id = Number(match[1]);
  const name = match[2] ? match[2].trim() : null;
  const teacher = promoteToTeacher(id, name);
  bot.sendMessage(msg.chat.id, `✅ ${id} endi ustoz${teacher.display_name ? ' — ' + teacher.display_name : ''}. Kalit: ${teacher.teacher_key}`);
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

bot.onText(/^\/teachers$/, (msg) => {
  if(!isAdmin(msg.from.id)) return;
  const data = store.load();
  const rows = Object.values(data.users).filter(u => u.role === 'teacher');
  if(rows.length === 0){
    bot.sendMessage(msg.chat.id, "Hozircha ustozlar yo'q. /addteacher <id> <Ism Familya> orqali qo'shing yoki /admin panelidan foydalaning.");
    return;
  }
  const text = rows.map(r => `• ${r.display_name || r.first_name || '(nomsiz)'} (@${r.username || '-'}) — ID: ${r.telegram_id}`).join('\n');
  bot.sendMessage(msg.chat.id, `Ustozlar:\n${text}`);
});

/* ================= HTTP API ================= */
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/admin', express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.send('Prufungs bot server ishlayapti.');
});

function requireAdmin(req, res, next){
  const pass = req.headers['x-admin-password'];
  if(!ADMIN_PASSWORD || pass !== ADMIN_PASSWORD){
    return res.status(401).json({ error: 'unauthorized' });
  }
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
  res.json({ status: session.status });
});

/* ---- Sayt uchun ochiq (auth talab qilmaydigan) ustozlar ro'yxati ---- */
app.get('/api/teachers/public', (req, res) => {
  const data = store.load();
  const teachers = Object.values(data.users)
    .filter(u => u.role === 'teacher' && u.display_name && u.teacher_key)
    .map(u => ({ key: u.teacher_key, name: u.display_name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ teachers });
});

/* ---- O'quvchi ishini yuborish: TANLANGAN ustozga + har doim adminga ---- */
app.post('/api/submit', async (req, res) => {
  const { studentName, teacherKey, level, category, taskTitle, text, wordCount, aiScore, aiFeedback } = req.body || {};
  if(!studentName || !text){
    return res.status(400).json({ error: "studentName va text majburiy" });
  }

  const submission = {
    id: null,
    student_name: String(studentName).slice(0, 200),
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

  const recipients = [];
  if(targetTeacher) recipients.push(targetTeacher.telegram_id);
  if(ADMIN_TELEGRAM_ID && Number(ADMIN_TELEGRAM_ID) !== (targetTeacher ? targetTeacher.telegram_id : null)){
    recipients.push(Number(ADMIN_TELEGRAM_ID));
  }

  const teacherLine = `\n👨‍🏫 Ustoz: ${targetTeacher ? targetTeacher.display_name : "tanlanmagan"}`;
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
});

/* ---- Ball tugmalari: "AI bali bilan qabul qilish" yoki "Ball kiritish" ---- */
bot.on('callback_query', async (query) => {
  const data = query.data || '';
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

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

  await bot.answerCallbackQuery(query.id);
});

/* ---- "Ball kiritish" bosilgach kutilayotgan matnli javobni qabul qiladi ---- */
bot.on('message', async (msg) => {
  if(!msg.text || msg.text.startsWith('/')) return; // buyruqlar alohida onText orqali ishlaydi
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

bot.onText(/^\/jadval$/, (msg) => {
  const access = rowsForRequester(msg.from.id);
  if(!access){ bot.sendMessage(msg.chat.id, "Bu buyruq faqat ustoz yoki admin uchun."); return; }
  const graded = access.rows
    .filter(r => r.final_score != null)
    .sort((a, b) => new Date(b.graded_at) - new Date(a.graded_at))
    .slice(0, 15);
  if(graded.length === 0){
    bot.sendMessage(msg.chat.id, "Hali baholangan ish yo'q.");
    return;
  }
  const lines = graded.map(r => {
    const d = new Date(r.graded_at);
    const dateStr = `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    return `${scoreEmoji(r.final_score)} ${dateStr} — ${r.student_name} — ${r.level}${r.category ? '/' + r.category : ''} — ${r.final_score}/100`;
  });
  bot.sendMessage(msg.chat.id, `📊 ${access.scope} — so'nggi baholangan ishlar:\n\n${lines.join('\n')}\n\nTo'liq jadval (Excel/CSV) uchun: /export`);
});

bot.onText(/^\/export$/, async (msg) => {
  const access = rowsForRequester(msg.from.id);
  if(!access){ bot.sendMessage(msg.chat.id, "Bu buyruq faqat ustoz yoki admin uchun."); return; }
  if(access.rows.length === 0){
    bot.sendMessage(msg.chat.id, "Hozircha ishlar yo'q.");
    return;
  }
  const csv = '\uFEFF' + toCSV(access.rows); // BOM — Excel'da o'zbekcha harflar to'g'ri ochilishi uchun
  const buffer = Buffer.from(csv, 'utf8');
  try{
    await bot.sendDocument(msg.chat.id, buffer, {}, { filename: `natijalar_${Date.now()}.csv`, contentType: 'text/csv' });
  }catch(err){
    console.error('sendDocument xatolik:', err.message);
    bot.sendMessage(msg.chat.id, "Faylni yuborishda xatolik yuz berdi.");
  }
});

/* ================= ADMIN API (/admin panel shu yerga murojaat qiladi) ================= */
app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const data = store.load();
  const users = Object.values(data.users);
  const teachers = users
    .filter(u => u.role === 'teacher')
    .map(u => ({ telegram_id: u.telegram_id, username: u.username, first_name: u.first_name, display_name: u.display_name || '', teacher_key: u.teacher_key }));
  const candidates = users
    .filter(u => u.role === 'student')
    .map(u => ({ telegram_id: u.telegram_id, username: u.username, first_name: u.first_name }));
  res.json({ teachers, candidates, submissionsCount: data.submissions.length });
});

app.post('/api/admin/teachers', requireAdmin, (req, res) => {
  const { telegramId, displayName } = req.body || {};
  if(!telegramId || !displayName){
    return res.status(400).json({ error: 'telegramId va displayName kerak' });
  }
  const teacher = promoteToTeacher(telegramId, String(displayName).trim());
  res.json({ ok: true, teacher });
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

app.listen(PORT, () => {
  console.log(`HTTP server ${PORT} portda ishga tushdi. DB: ${store.DB_PATH}`);
});
