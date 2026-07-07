const express = require('express');
const path = require('path');
const XLSX = require('xlsx');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 10000;
const LIMIT = 2000;
const ADMIN_ID = process.env.ADMIN_ID || '기군단';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '2대대';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL 환경변수가 없습니다. Render Environment에 DATABASE_URL을 추가해주세요.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));
app.get(['/', '/admin'], (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

function now() {
  return new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
}

function auth(req, res, next) {
  const id = decodeURIComponent(req.headers['x-admin-id'] || req.query.adminId || '');
  const pw = decodeURIComponent(req.headers['x-admin-password'] || req.query.password || '');
  if (id === ADMIN_ID && pw === ADMIN_PASSWORD) return next();
  return res.status(401).json({ error: '관리자 인증 실패' });
}

function arr(rows, cohort) {
  return (rows || []).map(x => ({
    id: x.id,
    cohort: x.cohort || cohort,
    platoon: x.platoon || '',
    name: x.name || '',
    address: x.address || '',
    bandPhone: x.band_phone || x.bandPhone || '',
    bank: x.bank || '',
    account: x.account || '',
    accountHolder: x.account_holder || x.accountHolder || '',
    createdAt: x.created_at_text || x.createdAt || '',
    updatedAt: x.updated_at_text || x.updatedAt || '',
    editCount: x.edit_count || x.editCount || 0
  }));
}

async function getSetting(key, fallback) {
  const r = await pool.query('select value from settings where key=$1', [key]);
  return r.rows[0]?.value || fallback;
}

async function setSetting(key, value) {
  await pool.query(
    `insert into settings(key,value) values($1,$2)
     on conflict(key) do update set value=excluded.value`,
    [key, value]
  );
}

async function ensureCohort(name) {
  await pool.query(
    `insert into settings(key,value) values($1,$2)
     on conflict(key) do nothing`,
    ['cohort:' + name, name]
  );
}

async function getCohorts() {
  const r = await pool.query(
    `select value from settings where key like 'cohort:%'
     union
     select distinct cohort as value from submissions
     order by value asc`
  );
  const list = r.rows.map(x => x.value);
  const active = await getSetting('active_cohort', '1기');
  if (!list.includes(active)) list.unshift(active);
  if (list.length === 0) list.push('1기');
  return list;
}

async function isClosed(cohort) {
  const v = await getSetting('closed:' + cohort, 'false');
  return v === 'true';
}

async function getClosedMap(cohorts) {
  const map = {};
  for (const c of cohorts) map[c] = await isClosed(c);
  return map;
}

app.get('/api/status', async (req, res) => {
  try {
    const activeCohort = await getSetting('active_cohort', '1기');
    await ensureCohort(activeCohort);
    const cohorts = await getCohorts();
    const obj = {};
    cohorts.forEach(c => obj[c] = []);
    const closed = await getClosedMap(cohorts);
    res.json({ limit: LIMIT, activeCohort, cohorts: obj, closed });
  } catch (e) {
    console.error('status error:', e);
    res.status(500).json({ error: '상태 조회 실패' });
  }
});

app.post('/api/submit', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.platoon || !b.name || !b.address || !b.bandPhone || !b.bank || !b.account || !b.accountHolder) {
      return res.status(400).json({ error: '모든 항목을 입력해주세요.' });
    }

    const cohort = await getSetting('active_cohort', '1기');
    await ensureCohort(cohort);

    if (await isClosed(cohort)) {
      return res.status(403).json({ error: '해당 기수는 마감되어 제출 또는 수정할 수 없습니다.' });
    }

    const count = await pool.query('select count(*)::int as cnt from submissions where cohort=$1', [cohort]);
    const existing = await pool.query(
      'select id from submissions where cohort=$1 and platoon=$2 and name=$3',
      [cohort, b.platoon, b.name]
    );

    if (existing.rows.length === 0 && count.rows[0].cnt >= LIMIT) {
      return res.status(400).json({ error: '제출 한도를 초과했습니다.' });
    }

    const t = now();

    const r = await pool.query(
      `insert into submissions
       (cohort, platoon, name, address, band_phone, bank, account, account_holder, created_at, updated_at, edit_count)
       values ($1,$2,$3,$4,$5,$6,$7,$8,now(),now(),0)
       on conflict (cohort, platoon, name)
       do update set
         address=excluded.address,
         band_phone=excluded.band_phone,
         bank=excluded.bank,
         account=excluded.account,
         account_holder=excluded.account_holder,
         updated_at=now(),
         edit_count=submissions.edit_count+1
       returning id, cohort, platoon, name, address, band_phone, bank, account, account_holder,
         to_char(created_at at time zone 'Asia/Seoul','YYYY. MM. DD. HH24시 MI분 SS초') as created_at_text,
         to_char(updated_at at time zone 'Asia/Seoul','YYYY. MM. DD. HH24시 MI분 SS초') as updated_at_text,
         edit_count`,
      [cohort, b.platoon, b.name, b.address, b.bandPhone, b.bank, b.account, b.accountHolder]
    );

    console.log('submit saved:', cohort, b.platoon, b.name);
    res.json({ ok: true, item: arr(r.rows, cohort)[0], time: t });
  } catch (e) {
    console.error('submit error:', e);
    res.status(500).json({ error: '제출 저장 중 오류가 발생했습니다.' });
  }
});

app.post('/api/admin/login', (req, res) => {
  const b = req.body || {};
  if (b.id === ADMIN_ID && b.password === ADMIN_PASSWORD) return res.json({ ok: true });
  return res.status(401).json({ error: '관리자 인증 실패' });
});

app.post('/api/admin/cohort', auth, async (req, res) => {
  try {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: '기수를 입력해주세요.' });
    await ensureCohort(name);
    await setSetting('active_cohort', name);
    console.log('cohort created:', name);
    res.json({ ok: true, activeCohort: name });
  } catch (e) {
    console.error('cohort error:', e);
    res.status(500).json({ error: '기수 생성 중 오류가 발생했습니다.' });
  }
});

app.get('/api/admin/create-cohort', auth, async (req, res) => {
  try {
    const name = (req.query.name || '').trim();
    if (!name) return res.status(400).json({ error: '기수를 입력해주세요.' });
    await ensureCohort(name);
    await setSetting('active_cohort', name);
    console.log('cohort created:', name);
    res.json({ ok: true, activeCohort: name });
  } catch (e) {
    console.error('cohort error:', e);
    res.status(500).json({ error: '기수 생성 중 오류가 발생했습니다.' });
  }
});


app.post('/api/admin/close-cohort', auth, async (req, res) => {
  try {
    const cohort = (req.body?.cohort || req.query.cohort || await getSetting('active_cohort', '1기')).trim();
    if (!cohort) return res.status(400).json({ error: '기수를 선택해주세요.' });
    await ensureCohort(cohort);
    await setSetting('closed:' + cohort, 'true');
    console.log('cohort closed:', cohort);
    res.json({ ok: true, cohort, closed: true });
  } catch (e) {
    console.error('close cohort error:', e);
    res.status(500).json({ error: '기수 마감 중 오류가 발생했습니다.' });
  }
});

app.post('/api/admin/open-cohort', auth, async (req, res) => {
  try {
    const cohort = (req.body?.cohort || req.query.cohort || await getSetting('active_cohort', '1기')).trim();
    if (!cohort) return res.status(400).json({ error: '기수를 선택해주세요.' });
    await ensureCohort(cohort);
    await setSetting('closed:' + cohort, 'false');
    console.log('cohort opened:', cohort);
    res.json({ ok: true, cohort, closed: false });
  } catch (e) {
    console.error('open cohort error:', e);
    res.status(500).json({ error: '기수 마감 해제 중 오류가 발생했습니다.' });
  }
});

app.get('/api/submissions', auth, async (req, res) => {
  try {
    const cohort = req.query.cohort || await getSetting('active_cohort', '1기');
    const q = (req.query.q || '').trim();
    let sql = `
      select id, cohort, platoon, name, address, band_phone, bank, account, account_holder,
        to_char(created_at at time zone 'Asia/Seoul','YYYY. MM. DD. HH24시 MI분 SS초') as created_at_text,
        to_char(updated_at at time zone 'Asia/Seoul','YYYY. MM. DD. HH24시 MI분 SS초') as updated_at_text,
        edit_count
      from submissions where cohort=$1`;
    const params = [cohort];
    if (q) {
      sql += ` and (platoon ilike $2 or name ilike $2)`;
      params.push('%' + q + '%');
    }
    sql += ` order by platoon asc, name asc`;
    const r = await pool.query(sql, params);
    res.json({ total: r.rows.length, items: arr(r.rows, cohort) });
  } catch (e) {
    console.error('submissions error:', e);
    res.status(500).json({ error: '관리자 데이터를 불러오지 못했습니다.' });
  }
});

app.delete('/api/submissions/:id', auth, async (req, res) => {
  try {
    await pool.query('delete from submissions where id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('delete error:', e);
    res.status(500).json({ error: '삭제 중 오류가 발생했습니다.' });
  }
});

app.post('/api/submissions/:id', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const r = await pool.query(
      `update submissions set
        platoon=$1, name=$2, address=$3, band_phone=$4, bank=$5, account=$6, account_holder=$7,
        updated_at=now(), edit_count=edit_count+1
       where id=$8
       returning id, cohort, platoon, name, address, band_phone, bank, account, account_holder,
        to_char(created_at at time zone 'Asia/Seoul','YYYY. MM. DD. HH24시 MI분 SS초') as created_at_text,
        to_char(updated_at at time zone 'Asia/Seoul','YYYY. MM. DD. HH24시 MI분 SS초') as updated_at_text,
        edit_count`,
      [b.platoon, b.name, b.address, b.bandPhone, b.bank, b.account, b.accountHolder, req.params.id]
    );
    res.json({ ok: true, item: arr(r.rows)[0] });
  } catch (e) {
    console.error('update error:', e);
    res.status(500).json({ error: '수정 중 오류가 발생했습니다.' });
  }
});

app.get('/api/export', auth, async (req, res) => {
  try {
    const cohort = req.query.cohort || await getSetting('active_cohort', '1기');
    const r = await pool.query(
      `select cohort, platoon, name, address, band_phone, bank, account, account_holder,
        to_char(created_at at time zone 'Asia/Seoul','YYYY. MM. DD. HH24시 MI분 SS초') as created_at_text,
        to_char(updated_at at time zone 'Asia/Seoul','YYYY. MM. DD. HH24시 MI분 SS초') as updated_at_text,
        edit_count
       from submissions where cohort=$1 order by platoon asc, name asc`,
      [cohort]
    );

    const rows = r.rows.map(x => ({
      '기수': x.cohort,
      '소대번호': x.platoon,
      '이름': x.name,
      '사복택배 주소': x.address,
      'BAND 전화번호': x.band_phone,
      '월급 받을 은행': x.bank,
      '계좌번호': x.account,
      '예금주': x.account_holder,
      '제출 시간': x.created_at_text,
      '최근 수정': x.updated_at_text,
      '수정 횟수': x.edit_count
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, cohort);
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(cohort)}_submissions.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e) {
    console.error('export error:', e);
    res.status(500).json({ error: '엑셀 다운로드 중 오류가 발생했습니다.' });
  }
});

app.listen(PORT, async () => {
  console.log('Navyform server running on http://localhost:' + PORT);
  try {
    await pool.query('select 1');
    console.log('Supabase DB connected');
  } catch (e) {
    console.error('Supabase DB connection failed:', e.message);
  }
});
