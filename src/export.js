// Eksport dla kadr (krok 7): CSV otwierany wprost w polskim Excelu — średnik, UTF-8 z BOM, daty dd/mm/rrrr.
//   summary  — jedna osoba = jeden wiersz: wymiar, zaległy, wykorzystane, pozostało, rodzaje poza pulą
//   requests — zatwierdzone wnioski w roku (także z prośbą o anulowanie — do decyzji nadal obowiązują)
const db = require('./db');
const leave = require('./leave');

const PL = require('../public/js/holidays.js');

const fmt = s => (s ? s.slice(0, 10).split('-').reverse().join('/') : '');
// decided_at z SQLite datetime('now') jest w UTC — w pliku data lokalna (TZ=Europe/Warsaw)
const fmtTs = s => (s ? fmt(PL.iso(new Date(s.replace(' ', 'T') + 'Z'))) : '');
const STATE = { active: 'aktywne', disabled: 'wyłączone' };
const STATUS = { approved: 'zatwierdzony', cancel_requested: 'zatwierdzony (prośba o anulowanie)' };

/** Komórka CSV: liczby bez zmian; tekst w cudzysłowie, gdy trzeba; ochrona przed formułami (=, +, -, @ na początku) */
function cell(v) {
  if (v == null) return '';
  if (typeof v === 'number') return String(v);
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[";\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}
const toCsv = rows => '﻿' + rows.map(r => r.map(cell).join(';')).join('\r\n') + '\r\n';

const q = {
  people: db.prepare(`SELECT id, first_name, last_name, email, state FROM users WHERE state <> 'invited'`),
  typeDays: db.prepare(`SELECT type, COALESCE(SUM(days), 0) AS days FROM leave_requests
                        WHERE user_id = ? AND substr(date_from, 1, 4) = ? AND status IN ('approved', 'cancel_requested')
                        GROUP BY type`),
  approved: db.prepare(`
    SELECT u.last_name, u.first_name, u.email, r.type, r.date_from, r.date_to, r.days, r.status, r.decided_at,
           trim(d.first_name || ' ' || d.last_name) AS decided_by, trim(s.first_name || ' ' || s.last_name) AS substitute
    FROM leave_requests r JOIN users u ON u.id = r.user_id
    LEFT JOIN users d ON d.id = r.decided_by LEFT JOIN users s ON s.id = r.substitute_id
    WHERE substr(r.date_from, 1, 4) = ? AND r.status IN ('approved', 'cancel_requested')
      AND r.days > 0                 -- urlop, który cały wypadł na dni wolne w firmie, nie jest nieobecnością`),
};
const collator = new Intl.Collator('pl', { sensitivity: 'base' });
const byName = (a, b) => collator.compare(a.last_name, b.last_name) || collator.compare(a.first_name, b.first_name);

function summary(year) {
  const head = ['Nazwisko', 'Imię', 'E-mail', 'Konto', 'Wymiar', `Zaległy z ${year - 1}`, 'Pula razem', 'Wykorzystane',
    'Czeka na akceptację', 'Pozostało', 'w tym na żądanie', 'Okolicznościowy', 'Opieka nad dzieckiem (art. 188)',
    'Siła wyższa (art. 148¹)', 'Bezpłatny'];
  const rows = q.people.all().sort(byName).flatMap(u => {
    const b = leave.balance(u.id, year);
    const t = Object.fromEntries(q.typeDays.all(u.id, String(year)).map(x => [x.type, x.days]));
    if (!b && !Object.keys(t).length) return []; // bez puli i bez urlopu w tym roku — pomijamy
    return [[
      u.last_name, u.first_name, u.email, STATE[u.state] || u.state,
      b ? b.days : null, b ? b.carried : null, b ? b.days + b.carried : null, b ? b.used : null, b ? b.pending : null, b ? b.left : null,
      t.na_zadanie || 0, t.okolicznosciowy || 0, t.opieka_188 || 0, t.sila_wyzsza || 0, t.bezplatny || 0,
    ]];
  });
  return toCsv([head, ...rows]);
}

function requests(year) {
  const head = ['Nazwisko', 'Imię', 'E-mail', 'Rodzaj', 'Od', 'Do', 'Dni robocze', 'Status', 'Zatwierdził(a)', 'Data decyzji', 'Zastępstwo'];
  const rows = q.approved.all(String(year))
    .sort((a, b) => byName(a, b) || a.date_from.localeCompare(b.date_from))
    .map(r => [r.last_name, r.first_name, r.email, leave.TYPE_LABELS[r.type], fmt(r.date_from), fmt(r.date_to), r.days,
      STATUS[r.status], r.decided_by, fmtTs(r.decided_at), r.substitute]);
  return toCsv([head, ...rows]);
}

module.exports = { summary, requests, cell };
