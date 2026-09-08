const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const TelegramBot = require('node-telegram-bot-api');
const store = require('./store');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || null; // hali o'rnatilmagan bo'lishi mumkin
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

function upsertUser(from){
  return store.update((data) => {
    const key = String(from.id);
    const existing = data.users[key];
    const role = isAdmin(from.id) ? 'admin' : (existing ? existing.role : 'student');
    data.users[key] = {
      telegram_id: from.id,
      username: from.username || null,
      first_name: from.first_name || null,
      role,
      created_at: existing ? existing.created_at : new Date().toISOString()
    };
    return data.users[key];
  });
}

function listTeachersAndAdmins(){
  const data = store.load();
  return Object.values(data.users).filter(u => u.role === 'teacher' || u.role === 'admin');
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
    lines.push('', 'Siz adminsiz. Buyruqlar:', '/addteacher <id> — ustoz qo\'shish', '/removeteacher <id> — ustozni olib tashlash', '/teachers — ustozlar ro\'yxati');
  } else if(user.role === 'teacher'){
    lines.push('', 'Siz ustoz sifatida ro\'yxatdan o\'tgansiz. O\'quvchilar yuborgan Schreiben ishlari shu yerga keladi.');
  } else {
    lines.push('', 'Agar ustoz bo\'lsangiz, shu ID raqamni Adminga yuboring — u sizni ustoz sifatida qo\'shadi.');
  }
  bot.sendMessage(chatId, lines.join('\n'));
});

bot.onText(/^\/whoami$/, (msg) => {
  const user = upsertUser(msg.from);
  bot.sendMessage(msg.chat.id, `ID: ${msg.from.id}\nRol: ${user.role}`);
});

bot.onText(/^\/addteacher\s+(\d+)$/, (msg, match) => {
  if(!isAdmin(msg.from.id)) return;
  const id = Number(match[1]);
  store.update((data) => {
    const key = String(id);
    if(data.users[key]){
      data.users[key].role = 'teacher';
    } else {
      data.users[key] = { telegram_id: id, username: null, first_name: null, role: 'teacher', created_at: new Date().toISOString() };
    }
  });
  bot.sendMessage(msg.chat.id, `✅ ${id} endi ustoz sifatida belgilandi.`);
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
    bot.sendMessage(msg.chat.id, "Hozircha ustozlar yo'q. /addteacher <id> orqali qo'shing.");
    return;
  }
  const text = rows.map(r => `• ${r.first_name || '(nomsiz)'} (@${r.username || '-'}) — ID: ${r.telegram_id}`).join('\n');
  bot.sendMessage(msg.chat.id, `Ustozlar:\n${text}`);
});

/* ================= HTTP API (sayt shu yerga murojaat qiladi) ================= */
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/', (req, res) => {
  res.send('Prufungs bot server ishlayapti.');
});

// 1) Sayt shu endpoint'ni chaqirib, Telegram bot'ga deep-link oladi.
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

// 2) Sayt shu endpoint'ni har 2-3 sekundda so'raydi (polling), toki status "confirmed" bo'lguncha.
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

// 3) O'quvchi Schreiben ishini AI tekshiruvidan o'tkazgach, sayt shu yerga yuboradi.
//    Bot bu ma'lumotni barcha ustoz/adminlarga Telegram orqali yetkazadi.
app.post('/api/submit', async (req, res) => {
  const { studentName, level, category, taskTitle, text, wordCount, aiScore, aiFeedback } = req.body || {};
  if(!studentName || !text){
    return res.status(400).json({ error: "studentName va text majburiy" });
  }

  const submission = {
    id: null,
    student_name: String(studentName).slice(0, 200),
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
    // saqlanadigan ish tarixini cheksiz o'stirmaslik uchun oxirgi 500 tasini saqlaymiz
    if(data.submissions.length > 500) data.submissions = data.submissions.slice(-500);
  });

  const recipients = listTeachersAndAdmins();
  const header = `📝 Yangi Schreiben ishi\n\n👤 ${submission.student_name}\n📚 Daraja: ${(submission.level || '').toUpperCase()}${submission.category ? ' / ' + submission.category : ''}\n📌 Mavzu: ${submission.task_title || '-'}\n🔢 So'zlar soni: ${submission.word_count}`;
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
  for(const r of recipients){
    for(const chunk of chunks){
      try{
        await bot.sendMessage(r.telegram_id, chunk);
      }catch(err){
        console.error(`sendMessage xatolik (${r.telegram_id}):`, err.message);
      }
    }
    notified++;
  }

  res.json({ ok: true, submissionId: submission.id, teachersNotified: notified });
});

app.listen(PORT, () => {
  console.log(`HTTP server ${PORT} portda ishga tushdi. DB: ${store.DB_PATH}`);
});
