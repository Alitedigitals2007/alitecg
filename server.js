require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;
const root = __dirname;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined,
  max: 5
});

app.set('view engine', 'ejs');
app.set('views', path.join(root, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(root, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype))
});

async function initDb() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS submissions (
      id SERIAL PRIMARY KEY,
      unique_code TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      school TEXT NOT NULL,
      phone_number TEXT NOT NULL,
      submission_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      rejection_reason TEXT NOT NULL DEFAULT '',
      vcf_formatted_name TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS proofs (
      submission_id INTEGER PRIMARY KEY REFERENCES submissions(id) ON DELETE CASCADE,
      mime TEXT NOT NULL,
      data BYTEA NOT NULL
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    await pool.query('ALTER TABLE submissions DROP COLUMN IF EXISTS proof_image_url');
    await pool.query(`INSERT INTO settings (key, value) VALUES ('channel_link', $1) ON CONFLICT (key) DO NOTHING`, ['https://wa.me/channel/PLACEHOLDER-CHANGE-ME']);
    await pool.query(`INSERT INTO settings (key, value) VALUES ('group_link', $1) ON CONFLICT (key) DO NOTHING`, ['https://chat.whatsapp.com/PLACEHOLDER-CHANGE-ME']);
  } catch (err) {
    if (err.code === '42P07' || err.code === '42710' || err.code === '23505') return;
    throw err;
  }
}
let dbReady = (async () => {
  for (let attempt = 1; ; attempt++) {
    try { await initDb(); return; } catch (err) { if (attempt >= 5 || err.code === '42P07' || err.code === '42710' || err.code === '23505') { try { await initDb(); return; } catch (e) { throw e; } } await new Promise((r) => setTimeout(r, attempt * 1500)); }
  }
})();

const wrap = (fn) => (req, res, next) => dbReady.then(() => fn(req, res, next)).catch(next);

async function getSettings() {
  const { rows } = await pool.query('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function mapUser(row) {
  return { id: row.id, uniqueCode: row.unique_code, fullName: row.full_name, school: row.school, phoneNumber: row.phone_number, submissionType: row.submission_type, proofImageUrl: `/proof/${row.unique_code}`, status: row.status, rejectionReason: row.rejection_reason, vcfFormattedName: row.vcf_formatted_name, createdAt: row.created_at };
}

function code() { return `ALC-${crypto.randomInt(10000, 99999)}`; }
function escapeVcf(value) { return String(value).replace(/[\\;,]/g, '\\$&').replace(/\r?\n/g, '\\n'); }
function labelFor(user) { return user.school === 'Not in School' ? `ALC: ${user.fullName}` : `ALC: ${user.fullName} ${user.school}`; }
function notifyTelegram(user) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;
  const text = `🔔 NEW CONTACT GAIN SUBMISSION\n\nTracking Code: ${user.uniqueCode}\nName: ${user.fullName}\nSchool: ${user.school}\nType: ${user.submissionType}\nPhone: ${user.phoneNumber}\n\n👉 Verify: ${process.env.PUBLIC_URL || ''}/admin/verify/${user.uniqueCode}`;
  fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text }) }).catch(() => {});
}
function admin(req, res, next) {
  const key = req.query.key || req.body.adminKey || req.headers['x-admin-key'];
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) return res.status(401).render('message', { title: 'Admin access required', message: 'Add the configured admin key to continue.', link: '/admin?key=' + encodeURIComponent(process.env.ADMIN_KEY || '') });
  next();
}

app.get('/', wrap(async (req, res) => res.render('home', { settings: await getSettings() })));

app.post('/submit', upload.single('proof'), wrap(async (req, res) => {
  const { fullName, school, phoneNumber, submissionType, channelFollowed } = req.body;
  if (!channelFollowed || !fullName || !school || !phoneNumber || !['VERIFICATION', 'BUY_VCF'].includes(submissionType) || !req.file) return res.status(400).render('message', { title: 'Submission incomplete', message: 'Please follow the channel and complete every field with a valid image proof.', link: '/' });
  let uniqueCode = code();
  for (;;) {
    const { rows } = await pool.query('SELECT 1 FROM submissions WHERE unique_code = $1', [uniqueCode]);
    if (!rows.length) break;
    uniqueCode = code();
  }
  const client = await pool.connect();
  let row;
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      'INSERT INTO submissions (unique_code, full_name, school, phone_number, submission_type) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [uniqueCode, fullName.trim(), school, phoneNumber.trim(), submissionType]
    );
    row = inserted.rows[0];
    await client.query('INSERT INTO proofs (submission_id, mime, data) VALUES ($1, $2, $3)', [row.id, req.file.mimetype, req.file.buffer]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    client.release();
    throw err;
  }
  client.release();
  const user = mapUser(row);
  notifyTelegram(user);
  res.render('submitted', { user, settings: await getSettings() });
}));

app.get('/check-status', (req, res) => res.render('status', { result: null, query: '' }));

app.post('/api/search', wrap(async (req, res) => {
  const query = String(req.body.query || '').trim().toLowerCase();
  const { rows } = await pool.query('SELECT * FROM submissions WHERE LOWER(unique_code) = $1 OR LOWER(phone_number) = $1', [query]);
  if (!rows.length) return res.status(404).json({ error: 'No submission found for that code or phone number.' });
  res.json({ user: mapUser(rows[0]) });
}));

app.get('/proof/:code', admin, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT p.mime, p.data FROM proofs p JOIN submissions s ON s.id = p.submission_id WHERE s.unique_code = $1', [req.params.code]);
  if (!rows.length) return res.status(404).send('Not found');
  res.set('Content-Type', rows[0].mime);
  res.send(rows[0].data);
}));

app.get('/admin', admin, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM submissions ORDER BY created_at DESC');
  res.render('admin', { users: rows.map(mapUser), key: req.query.key });
}));

app.get('/admin/settings', admin, wrap(async (req, res) => {
  res.render('admin-settings', { settings: await getSettings(), key: req.query.key, saved: req.query.saved === '1' });
}));

app.post('/admin/settings', admin, wrap(async (req, res) => {
  const channelLink = String(req.body.channelLink || '').trim();
  const groupLink = String(req.body.groupLink || '').trim();
  const key = req.body.adminKey || req.query.key;
  if (!channelLink || !groupLink) return res.status(400).render('message', { title: 'Missing links', message: 'Both the channel link and the group link are required.', link: '/admin/settings?key=' + encodeURIComponent(key || '') });
  await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', ['channel_link', channelLink]);
  await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', ['group_link', groupLink]);
  res.redirect('/admin/settings?key=' + encodeURIComponent(key) + '&saved=1');
}));

app.get('/admin/verify/:code', admin, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM submissions WHERE unique_code = $1', [req.params.code]);
  if (!rows.length) return res.status(404).render('message', { title: 'Submission not found', message: 'That tracking code does not exist.', link: '/admin?key=' + encodeURIComponent(req.query.key) });
  res.render('verify', { user: mapUser(rows[0]), key: req.query.key });
}));

app.post('/admin/approve/:code', admin, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM submissions WHERE unique_code = $1', [req.params.code]);
  if (!rows.length) return res.status(404).send('Not found');
  const user = mapUser(rows[0]);
  if (user.status !== 'APPROVED') {
    await pool.query("UPDATE submissions SET status = 'APPROVED', vcf_formatted_name = $1 WHERE id = $2", [labelFor(user), user.id]);
  }
  res.redirect('/admin?key=' + encodeURIComponent(req.body.adminKey));
}));

app.post('/admin/reject/:code', admin, wrap(async (req, res) => {
  const reason = String(req.body.reason || 'Proof could not be verified.').trim();
  const { rowCount } = await pool.query("UPDATE submissions SET status = 'REJECTED', rejection_reason = $1 WHERE unique_code = $2", [reason, req.params.code]);
  if (!rowCount) return res.status(404).send('Not found');
  res.redirect('/admin?key=' + encodeURIComponent(req.body.adminKey));
}));

app.get('/download/vcf', admin, wrap(async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM submissions WHERE status = 'APPROVED' ORDER BY created_at ASC");
  if (!rows.length) return res.status(404).render('message', { title: 'No approved contacts yet', message: 'Approved contacts will appear here.', link: '/admin?key=' + encodeURIComponent(req.query.key) });
  const vcf = rows.map((row) => `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:${escapeVcf(row.vcf_formatted_name)}\r\nTEL;TYPE=CELL:${escapeVcf(row.phone_number)}\r\nNOTE:${escapeVcf(row.unique_code)}\r\nEND:VCARD`).join('\r\n') + '\r\n';
  res.setHeader('Content-Disposition', 'attachment; filename="alotedigitals-contacts.vcf"');
  res.type('text/vcard; charset=utf-8').send(vcf);
}));

app.use((err, req, res, next) => res.status(400).render('message', { title: 'Could not process request', message: err.message || 'Please try again.', link: '/' }));

if (!process.env.VERCEL) {
  dbReady.then(() => {
    app.listen(port, () => console.log(`Alotedigitals platform running at http://localhost:${port}`));
  }).catch((err) => {
    console.error('Failed to initialize database:', err.message);
    process.exit(1);
  });
}

module.exports = app;
