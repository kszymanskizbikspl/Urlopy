// /api/me — dane zalogowanego użytkownika. Kolejne endpointy (saldo, wnioski) w kroku 5.
const express = require('express');
const { requireApi } = require('../auth');

const router = express.Router();

router.get('/', requireApi(), (req, res) => {
  const { id, email, first_name, last_name, role } = req.user;
  res.set('Cache-Control', 'no-store');
  res.json({ id, email, first_name, last_name, role, csrf: req.session.csrf });
});

module.exports = router;
