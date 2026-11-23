/* Polskie dni ustawowo wolne od pracy + liczenie dni roboczych.
   Ten sam plik można zaimportować w backendzie Node.js (require('./holidays.js')),
   żeby serwer liczył dni identycznie jak przeglądarka. Serwer zawsze przelicza od nowa. */
(function (root) {
  const pad = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

  // Wielkanoc — algorytm Meeusa/Jonesa/Butchera (kalendarz gregoriański)
  function easter(y) {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100;
    const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(y, month - 1, day);
  }

  const cache = {};
  /** Map 'YYYY-MM-DD' -> nazwa święta */
  function holidays(y) {
    if (cache[y]) return cache[y];
    const e = easter(y);
    const list = [
      [new Date(y, 0, 1), 'Nowy Rok'],
      [new Date(y, 0, 6), 'Trzech Króli'],
      [e, 'Wielkanoc'],
      [addDays(e, 1), 'Poniedziałek Wielkanocny'],
      [new Date(y, 4, 1), 'Święto Pracy'],
      [new Date(y, 4, 3), 'Święto Konstytucji 3 Maja'],
      [addDays(e, 49), 'Zielone Świątki'],
      [addDays(e, 60), 'Boże Ciało'],
      [new Date(y, 7, 15), 'Wniebowzięcie NMP'],
      [new Date(y, 10, 1), 'Wszystkich Świętych'],
      [new Date(y, 10, 11), 'Narodowe Święto Niepodległości'],
      [new Date(y, 11, 25), 'Boże Narodzenie'],
      [new Date(y, 11, 26), 'Drugi dzień Bożego Narodzenia'],
    ];
    if (y >= 2025) list.push([new Date(y, 11, 24), 'Wigilia']); // wolna od 2025 r.
    const map = new Map();
    list.sort((a, b) => a[0] - b[0]).forEach(([d, n]) => map.set(iso(d), n));
    return (cache[y] = map);
  }

  const holidayName = s => holidays(+s.slice(0, 4)).get(s) || null;

  /** extraOff: Set lub Map z dodatkowymi dniami wolnymi w firmie (np. za święto w sobotę) */
  function isWorkingDay(d, extraOff) {
    const dow = d.getDay();
    if (dow === 0 || dow === 6) return false;
    const s = iso(d);
    return !holidayName(s) && !(extraOff && extraOff.has(s));
  }

  function countWorkingDays(from, to, extraOff) {
    let n = 0;
    for (let d = parse(from), end = parse(to); d <= end; d = addDays(d, 1)) if (isWorkingDay(d, extraOff)) n++;
    return n;
  }

  /** Święta wypadające w sobotę — pracodawca musi wyznaczyć za nie inny dzień wolny (art. 130 § 2 KP) */
  const saturdayHolidays = y => [...holidays(y)].filter(([s]) => parse(s).getDay() === 6).map(([date, name]) => ({ date, name }));

  const api = { iso, parse, addDays, easter, holidays, holidayName, isWorkingDay, countWorkingDays, saturdayHolidays };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PL = api;
})(typeof window !== 'undefined' ? window : globalThis);
