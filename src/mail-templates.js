// Treści e-maili (tekst + prosty HTML). Każda funkcja zwraca { subject, text, html }.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// dd/mm/rrrr, gg:mm (czas lokalny serwera — TZ=Europe/Warsaw w Dockerfile)
const pad = n => String(n).padStart(2, '0');
const fmtDateTime = iso => {
  const d = new Date(iso);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const hello = name => (name ? `Dzień dobry ${name},` : 'Dzień dobry,');

/** Wspólny układ HTML: akapity + opcjonalny przycisk z linkiem.
    Element paragraphs: tekst HTML (owijany w <p>) albo { raw } — blok wstawiany bez <p> (np. tabela; <table> w <p> to błędny HTML). */
function layout({ paragraphs, button, footer }) {
  const p = t => (t && typeof t === 'object' ? t.raw : `<p style="margin:0 0 14px">${t}</p>`);
  const btn = button
    ? `<p style="margin:22px 0"><a href="${esc(button.href)}" style="background:#1f5fae;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">${esc(button.label)}</a></p>
       <p style="margin:0 0 14px;font-size:13px;color:#666">Jeśli przycisk nie działa, skopiuj ten adres do przeglądarki:<br><span style="word-break:break-all">${esc(button.href)}</span></p>`
    : '';
  return `<!DOCTYPE html><html lang="pl"><body style="margin:0;padding:24px;background:#f4f5f7;font-family:Segoe UI,Arial,sans-serif;color:#1d1d1f;font-size:15px;line-height:1.5">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:28px">
<p style="margin:0 0 18px;font-weight:700;font-size:17px">Urlopy ZBIKS</p>
${paragraphs.map(p).join('\n')}
${btn}
${footer ? `<p style="margin:18px 0 0;font-size:13px;color:#666">${footer}</p>` : ''}
</div></body></html>`;
}

function invite({ firstName, inviter, link, expiresAt, year, days }) {
  const pool = days != null ? ` Twoja pula urlopu na ${year} r.: ${days} dni.` : '';
  const who = inviter ? `${inviter} zaprasza Cię` : 'Zapraszamy Cię';
  const until = fmtDateTime(expiresAt);
  return {
    subject: 'Zaproszenie do aplikacji Urlopy ZBIKS',
    text: `${hello(firstName)}

${who} do aplikacji Urlopy ZBIKS — tu złożysz wniosek urlopowy i sprawdzisz, ile dni Ci zostało.${pool}

Załóż konto (ustaw hasło) pod adresem:
${link}

Link jest ważny do ${until} i działa tylko raz. Aplikacja działa w sieci firmowej.
`,
    html: layout({
      paragraphs: [esc(hello(firstName)), `${esc(who)} do aplikacji Urlopy ZBIKS — tu złożysz wniosek urlopowy i sprawdzisz, ile dni Ci zostało.${esc(pool)}`],
      button: { href: link, label: 'Załóż konto' },
      footer: `Link jest ważny do ${esc(until)} i działa tylko raz. Aplikacja działa w sieci firmowej.`,
    }),
  };
}

function reset({ firstName, link, byAdmin }) {
  const why = byAdmin
    ? 'Administrator wysłał Ci link do ustawienia nowego hasła w aplikacji Urlopy ZBIKS.'
    : 'Ktoś (prawdopodobnie Ty) poprosił o zmianę hasła w aplikacji Urlopy ZBIKS.';
  return {
    subject: 'Ustaw nowe hasło — Urlopy ZBIKS',
    text: `${hello(firstName)}

${why}

Nowe hasło ustawisz pod adresem:
${link}

Link jest ważny przez godzinę i działa tylko raz. Jeśli to nie Ty, zignoruj tę wiadomość — obecne hasło nadal działa.
`,
    html: layout({
      paragraphs: [esc(hello(firstName)), esc(why)],
      button: { href: link, label: 'Ustaw nowe hasło' },
      footer: 'Link jest ważny przez godzinę i działa tylko raz. Jeśli to nie Ty, zignoruj tę wiadomość — obecne hasło nadal działa.',
    }),
  };
}

function passwordChanged({ firstName, when, appUrl }) {
  const at = fmtDateTime(when);
  return {
    subject: 'Hasło zostało zmienione — Urlopy ZBIKS',
    text: `${hello(firstName)}

Hasło do Twojego konta w aplikacji Urlopy ZBIKS zostało zmienione (${at}). Pozostałe urządzenia zostały wylogowane.

Jeśli to nie Ty, od razu skontaktuj się z administratorem.

${appUrl}
`,
    html: layout({
      paragraphs: [
        esc(hello(firstName)),
        `Hasło do Twojego konta w aplikacji Urlopy ZBIKS zostało zmienione (${esc(at)}). Pozostałe urządzenia zostały wylogowane.`,
        '<strong>Jeśli to nie Ty, od razu skontaktuj się z administratorem.</strong>',
      ],
    }),
  };
}

function test({ appUrl }) {
  return {
    subject: 'Test poczty — Urlopy ZBIKS',
    text: `To jest wiadomość testowa z aplikacji Urlopy ZBIKS.\n\nPoczta wychodząca działa. Linki w e-mailach będą prowadzić do: ${appUrl}\n`,
    html: layout({ paragraphs: ['To jest wiadomość testowa z aplikacji Urlopy ZBIKS.', `Poczta wychodząca działa. Linki w e-mailach będą prowadzić do: <strong>${esc(appUrl)}</strong>`] }),
  };
}

// ---------- wnioski urlopowe (krok 6) ----------
const fmtDate = s => s.split('-').reverse().join('/');                       // rrrr-mm-dd → dd/mm/rrrr
const fmtRange = (a, b) => (a === b ? fmtDate(a) : `${fmtDate(a)} – ${fmtDate(b)}`);
const plDays = n => (n === 1 ? '1 dzień' : `${n} dni`);

/** Wiersze „etykieta: wartość” — w tekście i w HTML */
const facts = rows => rows.filter(([, v]) => v != null && v !== '');
const factsText = rows => facts(rows).map(([k, v]) => `${k}: ${v}`).join('\n');
const factsHtml = rows => ({
  raw: `<table style="border-collapse:collapse;margin:0 0 14px">${facts(rows)
    .map(([k, v]) => `<tr><td style="padding:3px 16px 3px 0;color:#666;vertical-align:top">${esc(k)}</td><td style="padding:3px 0;font-weight:600">${esc(v)}</td></tr>`)
    .join('')}</table>`,
});

/** Do przełożonego: nowy wniosek, prośba o anulowanie zatwierdzonego urlopu albo wycofanie czekającego wniosku.
    r — wiersz wniosku z nazwami. */
function forApprover({ kind, approverFirst, employee, r, typeLabel, left, link }) {
  const term = fmtRange(r.date_from, r.date_to);
  const isNew = kind === 'request_new';
  const { subject, lead, action } = {
    request_new: { subject: `Nowy wniosek urlopowy: ${employee}, ${term}`, lead: `${employee} składa wniosek urlopowy.`, action: 'Rozpatrz wniosek' },
    cancel_request: {
      subject: `Prośba o anulowanie urlopu: ${employee}, ${term}`,
      lead: `${employee} prosi o anulowanie zatwierdzonego urlopu. Do Twojej decyzji urlop pozostaje zatwierdzony.`,
      action: 'Rozpatrz prośbę',
    },
    request_withdrawn: {
      subject: `Wniosek wycofany: ${employee}, ${term}`,
      lead: `${employee} wycofał(a) wniosek urlopowy, zanim został rozpatrzony. Nie musisz nic robić.`,
      action: null,
    },
  }[kind];
  const rows = [
    ['Termin', term],
    ['Dni robocze', `${r.days}, ${typeLabel.toLowerCase()}`],
    isNew && left != null ? ['Zostanie w puli', plDays(left)] : null,
    isNew ? ['Zastępstwo', r.substitute || 'brak'] : null,
    isNew ? ['Uwagi', r.note] : null,
  ].filter(Boolean);
  return {
    subject,
    text: `${hello(approverFirst)}

${lead}

${factsText(rows)}
${action ? `\n${action} w aplikacji:\n${link}\n` : ''}`,
    html: layout({
      paragraphs: [esc(hello(approverFirst)), esc(lead), factsHtml(rows)],
      button: action ? { href: link, label: action } : null,
    }),
  };
}

/** Do pracownika: decyzja. outcome: approved | rejected | cancelled (przez przełożonego) | cancel_accepted | kept (odmowa anulowania) */
function decision({ outcome, firstName, r, typeLabel, by, reason, link }) {
  const term = fmtRange(r.date_from, r.date_to);
  const what = {
    approved: [`Urlop zatwierdzony: ${term}`, `${by} zatwierdził(a) Twój wniosek urlopowy. W załączniku jest plik do dodania urlopu do kalendarza.`],
    rejected: [`Wniosek urlopowy odrzucony: ${term}`, `${by} odrzucił(a) Twój wniosek urlopowy.`],
    cancelled: [`Urlop anulowany: ${term}`, `${by} anulował(a) Twój zatwierdzony urlop. Dni wróciły do puli.`],
    cancel_accepted: [`Urlop anulowany na Twoją prośbę: ${term}`, `${by} zgodził(a) się na anulowanie urlopu. Dni wróciły do puli.`],
    kept: [`Prośba o anulowanie odrzucona: ${term}`, `${by} nie zgodził(a) się na anulowanie urlopu — urlop pozostaje zatwierdzony.`],
  }[outcome];
  const rows = [
    ['Termin', term],
    ['Dni robocze', `${r.days}, ${typeLabel.toLowerCase()}`],
    ['Powód', reason],
  ];
  return {
    subject: what[0],
    text: `${hello(firstName)}

${what[1]}

${factsText(rows)}

${link}
`,
    html: layout({ paragraphs: [esc(hello(firstName)), esc(what[1]), factsHtml(rows)], button: { href: link, label: 'Otwórz Urlopy ZBIKS' } }),
  };
}

/** Plik .ics: całodniowe wydarzenie na czas urlopu; cancel = usunięcie tego samego wydarzenia (ten sam UID, wyższy SEQUENCE).
    organizer / attendee: { email, name } — RFC 5546 wymaga ORGANIZER przy CANCEL, bez niego Outlook i Gmail nie usuwają wydarzenia. */
function ics({ r, typeLabel, host, cancel = false, organizer, attendee }) {
  const d = s => s.replace(/-/g, '');
  const next = s => { const [y, m, dd] = s.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, dd + 1)); return t.toISOString().slice(0, 10).replace(/-/g, ''); };
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  // wartości parametrów (CN) w cudzysłowie, bez znaków, które psują wiersz
  const cn = s => `"${String(s || '').replace(/["\r\n;:,\\]/g, ' ').trim()}"`;
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ZBIKS//Urlopy//PL', `METHOD:${cancel ? 'CANCEL' : 'PUBLISH'}`,
    'BEGIN:VEVENT',
    `UID:urlop-${r.id}@${host || 'urlopy-zbiks'}`,
    `DTSTAMP:${stamp}`,
    organizer ? `ORGANIZER;CN=${cn(organizer.name)}:mailto:${organizer.email}` : null,
    attendee ? `ATTENDEE;CN=${cn(attendee.name)};ROLE=REQ-PARTICIPANT:mailto:${attendee.email}` : null,
    `DTSTART;VALUE=DATE:${d(r.date_from)}`,
    `DTEND;VALUE=DATE:${next(r.date_to)}`,                 // DTEND dla całego dnia = dzień po ostatnim
    `SUMMARY:Urlop (${typeLabel.toLowerCase()})`,
    'TRANSP:OPAQUE',
    `SEQUENCE:${cancel ? 1 : 0}`,
    `STATUS:${cancel ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].filter(l => l !== null).join('\r\n');
}

module.exports = { invite, reset, passwordChanged, test, fmtDateTime, forApprover, decision, ics };
