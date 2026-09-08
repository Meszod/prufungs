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
  const scoreLine = submission.ai_score ? `\n⭐ Ball: ${submission.ai_score}/100` : '';
  const feedbackBlock = submission.ai_feedback ? `\n\n🧾 AI tekshiruvi:\n${submission.ai_feedback}` : '';
  const textBlock = `\n\n✍️ Matn:\n${submission.text_content}`;
  const fullMessage = header + scoreLine + feedbackBlock + textBlock;

  const CHUNK = 3500;
  const chunks = [];
  for(let i = 0; i < fullMessage.length; i += CHUNK){
    chunks.push(fullMessage.slice(i, i + CHUNK));
  }

  let notified = 0;
  for(const chatId of recipients){
    for(const chunk of chunks){
      try{
        await bot.sendMessage(chatId, chunk);
      }catch(err){
        console.error(`sendMessage xatolik (${chatId}):`, err.message);
      }
    }
    notified++;
  }

  res.json({ ok: true, submissionId: submission.id, notified });
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

app.listen(PORT, () => {
  console.log(`HTTP server ${PORT} portda ishga tushdi. DB: ${store.DB_PATH}`);
});
