# Schreiben Trainer B1

Nemis tili B1 Schreiben mashqi uchun interaktiv sayt: taymer, so'z/gap hisoblagichi va AI orqali baholash.

## Fayllar

- `index.html` — asosiy sayt (frontend)
- `netlify/functions/check-writing.js` — AI tekshirish uchun serverless funksiya (API kalitni yashirin saqlaydi)
- `netlify.toml` — Netlify konfiguratsiyasi

## GitHub'ga yuklash

```bash
cd schreiben-trainer
git init
git add .
git commit -m "Schreiben trainer B1"
git branch -M main
git remote add origin https://github.com/<username>/<repo-nomi>.git
git push -u origin main
```

## Netlify'da deploy qilish

1. [netlify.com](https://netlify.com) ga kiring → **Add new site → Import an existing project**
2. GitHub repongizni tanlang
3. Build sozlamalari avtomatik `netlify.toml`dan olinadi (qo'shimcha sozlash shart emas — Build command bo'sh qoldirilsin, Publish directory: `.`)
4. **Deploy site** tugmasini bosing

## AI tekshirish funksiyasini ishga tushirish (majburiy qadam)

AI orqali baholash ishlashi uchun Groq API kaliti kerak (bepul tier mavjud):

1. [console.groq.com/keys](https://console.groq.com/keys) da ro'yxatdan o'ting va API kalit oling
2. Netlify saytingizda: **Site settings → Environment variables → Add a variable**
   - Key: `GROQ_API_KEY`
   - Value: (o'z API kalitingiz)
3. **Site settings → Build & deploy → Trigger deploy → Deploy site** orqali qayta deploy qiling (env variable qo'shilgandan keyin qayta deploy shart)

Shundan so'ng "AI bilan tekshirish" tugmasi to'liq ishlaydi. Model sifatida `llama-3.3-70b-versatile` ishlatiladi — tez va bepul, lekin nemis tili baholashda ba'zan Claude kabi aniq bo'lmasligi mumkin. Kerak bo'lsa `netlify/functions/check-writing.js` ichidagi `model` qiymatini boshqa Groq modeliga almashtirish mumkin.

## Eslatma

API kaliti hech qachon `index.html` yoki frontend kodida yozilmasligi kerak — u faqat Netlify muhit o'zgaruvchisida, server tomonida (`check-writing.js` ichida) ishlatiladi.
