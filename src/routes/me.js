// /api/me — dane zalogowanego użytkownika (saldo i wnioski: routes/requests.js).
const express = require('express');
const db = require('../db');
const audit = require('../audit');
const settings = require('../settings');
const { requireApi } = require('../auth');
const { pendingCount } = require('./approvals');

const router = express.Router();

router.get('/', requireApi(), (req, res) => {
  const { id, email, first_name, last_name, role } = req.user;
  res.set('Cache-Control', 'no-store');
  const out = { id, email, first_name, last_name, role, csrf: req.session.csrf, pending_count: 0 };
  if (role !== 'employee') {
    // licznik „Wnioski” w menu: ile wniosków czeka na decyzję tej osoby
    out.pending_count = pendingCount(req.user);
    // poniedziałkowa lista nieobecnych: osobiste ustawienie + czy wysyłka jest w ogóle włączona (Ustawienia)
    out.weekly_digest = req.user.weekly_digest === 1;
    out.weekly_digest_global = settings.getAll().weekly_digest === '1';
  }
  res.json(out);
});

// Moje powiadomienia (przełożony, administrator): { weekly_digest: true | false }
const setDigest = db.prepare('UPDATE users SET weekly_digest = ? WHERE id = ?');
router.put('/notifications', requireApi(['manager', 'admin']), (req, res) => {
  const v = (req.body || {}).weekly_digest;
  if (typeof v !== 'boolean') return res.status(400).json({ error: 'weekly_digest: true albo false.' });
  setDigest.run(v ? 1 : 0, req.user.id);
  audit(req.user.id, 'notifications_changed', { weekly_digest: v });
  res.json({ weekly_digest: v });
});

module.exports = router;
