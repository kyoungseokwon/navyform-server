const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_SUBMISSIONS = 2000;
const db = new Database(path.join(__dirname, 'navyform.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platoon TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  bandPhone TEXT NOT NULL,
  bank TEXT NOT NULL,
  account TEXT NOT NULL,
  holder TEXT NOT NULL,
  submitCount INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  ip TEXT,
  UNIQUE(platoon, name)
);
`);

app.use(express.json());
app.use(express.static(__dirname));

function now() { return new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }); }
function clean(v) { return String(v || '').trim(); }
function allRows() { return db.prepare('SELECT * FROM submissions ORDER BY id DESC').all(); }

app.post('/api/submit', (req, res) => {
  const data = {
    platoon: clean(req.body.platoon),
    name: clean(req.body.name),
    address: clean(req.body.address),
    bandPhone: clean(req.body.bandPhone),
    bank: clean(req.body.bank),
    account: clean(req.body.account),
    holder: clean(req.body.holder)
  };

  if (Object.values(data).some(v => !v)) {
    return res.status(400).json({ message: '모든 항목을 입력해주세요.' });
  }

  const existing = db.prepare('SELECT * FROM submissions WHERE platoon = ? AND name = ?').get(data.platoon, data.name);
  const total = db.prepare('SELECT COUNT(*) AS count FROM submissions').get().count;

  if (!existing && total >= MAX_SUBMISSIONS) {
    return res.status(403).json({ message: `제출 가능 인원 ${MAX_SUBMISSIONS}명이 초과되었습니다.` });
  }

  const t = now();
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

  if (existing) {
    db.prepare(`UPDATE submissions SET address=?, bandPhone=?, bank=?, account=?, holder=?, submitCount=submitCount+1, updatedAt=?, ip=? WHERE id=?`)
      .run(data.address, data.bandPhone, data.bank, data.account, data.holder, t, ip, existing.id);
    return res.json({ ok: true, mode: 'update', message: '수정이 완료되었습니다.' });
  }

  db.prepare(`INSERT INTO submissions (platoon, name, address, bandPhone, bank, account, holder, createdAt, updatedAt, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(data.platoon, data.name, data.address, data.bandPhone, data.bank, data.account, data.holder, t, t, ip);
  res.json({ ok: true, mode: 'create', message: '제출이 완료되었습니다.' });
});

app.get('/api/submissions', (req, res) => {
  res.json({ limit: MAX_SUBMISSIONS, total: db.prepare('SELECT COUNT(*) AS count FROM submissions').get().count, rows: allRows() });
});

app.delete('/api/submissions/:id', (req, res) => {
  db.prepare('DELETE FROM submissions WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/export', (req, res) => {
  const rows = allRows().map(r => ({
    '소대번호': r.platoon,
    '이름': r.name,
    '사복택배 주소': r.address,
    'BAND 전화번호': r.bandPhone,
    '은행': r.bank,
    '계좌번호': r.account,
    '예금주': r.holder,
    '최초 제출': r.createdAt,
    '최근 수정': r.updatedAt,
    '수정 횟수': Math.max(0, r.submitCount - 1),
    'IP': r.ip
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, '제출현황');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="navyform-submissions.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

app.listen(PORT, () => console.log(`Navyform server running on http://localhost:${PORT}`));
