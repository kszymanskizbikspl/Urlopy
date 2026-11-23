// Treści e-maili (tekst + prosty HTML). Każda funkcja zwraca { subject, text, html }.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// dd/mm/rrrr, gg:mm (czas lokalny serwera — TZ=Europe/Warsaw w Dockerfile)
const pad = n => String(n).padStart(2, '0');
const fmtDateTime = iso => {
  const d = new Date(iso);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const hello = name => (name ? `Dzień dobry ${name},` : 'Dzień dobry,');

/** Wspólny układ HTML: akapity + opcjonalny przycisk z linkiem */
function layout({ paragraphs, button, footer }) {
  const p = t => `<p style="margin:0 0 14px">${t}</p>`;
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

module.exports = { invite, reset, passwordChanged, test, fmtDateTime };
