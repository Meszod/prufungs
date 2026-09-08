/*
  Juda oddiy fayl-asosidagi ma'lumotlar bazasi.
  Bu bot uchun yuklama past (bir nechta ustoz, cheklangan sonli obuna tekshiruvlari,
  navbat bilan keladigan yozma ishlar), shuning uchun native modul (masalan better-sqlite3)
  talab qiladigan haqiqiy SQL bazadan ko'ra, buildi hech qachon sinmaydigan oddiy JSON fayl
  ancha ishonchli. DB_PATH Railway'da doimiy volume ustiga ko'rsatiladi (masalan /data/app.json),
  shuning uchun deploy/restart'larda ma'lumot yo'qolmaydi.
*/
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'app.json');

function emptyState(){
  return { users: {}, verifySessions: {}, submissions: [], nextSubmissionId: 1 };
}

function load(){
  try{
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const data = JSON.parse(raw);
    return Object.assign(emptyState(), data);
  }catch(e){
    return emptyState();
  }
}

function save(data){
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const tmpPath = DB_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, DB_PATH);
}

/* Har bir chaqiruv o'qiydi -> o'zgartiradi -> yozadi. Bitta jarayon, past yuklama —
   race-condition xavfi amalda yo'q. */
function update(mutatorFn){
  const data = load();
  const result = mutatorFn(data);
  save(data);
  return result;
}

module.exports = { load, save, update, DB_PATH };
