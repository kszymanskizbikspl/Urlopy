// /api/me — dane zalogowanego użytkownika (saldo i wnioski: routes/requests.js).
const express = require('express');
const { requireApi } = require('../auth');
const { pendingCount } = require('./approvals');

const router = express.Router();

router.get('/', requireApi(), (req, res) => {
  const { id, email, first_name, last_name, role } = req.user;
  res.set('Cache-Control', 'no-store');
  // pending_count — licznik „Wnioski” w menu: ile wniosków czeka na decyzję tej osoby
  const pending_count = role === 'employee' ? 0 : pendingCount(req.user);
  res.json({ id, email, first_name, last_name, role, csrf: req.session.csrf, pending_count });
});

module.exports = router;
