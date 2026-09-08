# Prufungs bot

Schreiben trainer sayti (`../index.html`) uchun Telegram bot va HTTP API.

## Nima qiladi

- **Haqiqiy kanal obunasini tekshiradi** — `getChatMember` orqali (honor-system emas).
- **O'quvchi yozgan Schreiben ishini ustozga yuboradi** — AI tekshiruvidan o'tgan matn, ball va xatolar Telegram orqali barcha ustoz/adminlarga yetadi.
- **Admin/ustoz boshqaruvi** — admin `/addteacher <id>` orqali ustoz qo'shadi.

## Muhit o'zgaruvchilari (environment variables)

| Nomi | Majburiymi | Tavsif |
|---|---|---|
| `BOT_TOKEN` | ha | BotFather'dan olingan token |
| `ADMIN_TELEGRAM_ID` | ha (admin buyruqlari uchun) | Sizning (Admin) raqamli Telegram ID'ingiz. Botga `/start` yozib olishingiz mumkin. |
| `CHANNEL_USERNAME` | yo'q (standart: `@bedeutungslosM`) | Obuna tekshiriladigan kanal |
| `DB_PATH` | yo'q (standart: `./data/app.json`) | Ma'lumotlar saqlanadigan fayl. Railway'da doimiy volume ustiga ko'rsating, masalan `/data/app.json` |
| `PORT` | yo'q | Railway avtomatik beradi |

## Bot buyruqlari

- `/start` — ro'yxatdan o'tish, o'z ID va rolini ko'rish
- `/whoami` — ID va rolni ko'rsatadi
- `/addteacher <id>` — (faqat admin) foydalanuvchini ustoz qiladi
- `/removeteacher <id>` — (faqat admin) ustozlikdan olib tashlaydi
- `/teachers` — (faqat admin) ustozlar ro'yxati

## HTTP API (sayt shu yerga murojaat qiladi)

- `POST /api/verify/start` → `{ sessionId, deepLink }`
- `GET /api/verify/status/:sessionId` → `{ status: "pending" | "confirmed" | "expired" }`
- `POST /api/submit` — body: `{ studentName, level, category, taskTitle, text, wordCount, aiScore, aiFeedback }`

## Lokal ishga tushirish

```bash
npm install
BOT_TOKEN=... ADMIN_TELEGRAM_ID=... node server.js
```
