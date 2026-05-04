/** Japanese national holidays. Used for marking 祝日 in Excel exports.
 *
 *  Movable holidays (成人の日, 海の日, etc.) are pre-computed for the years we
 *  care about. If the app is used into 2028+, add entries below.
 */

const HOLIDAYS_2026: Record<string, string> = {
  "2026-01-01": "元日",
  "2026-01-12": "成人の日",
  "2026-02-11": "建国記念の日",
  "2026-02-23": "天皇誕生日",
  "2026-03-20": "春分の日",
  "2026-04-29": "昭和の日",
  "2026-05-03": "憲法記念日",
  "2026-05-04": "みどりの日",
  "2026-05-05": "こどもの日",
  "2026-05-06": "振替休日",
  "2026-07-20": "海の日",
  "2026-08-11": "山の日",
  "2026-09-21": "敬老の日",
  "2026-09-23": "秋分の日",
  "2026-10-12": "スポーツの日",
  "2026-11-03": "文化の日",
  "2026-11-23": "勤労感謝の日",
};

const HOLIDAYS_2027: Record<string, string> = {
  "2027-01-01": "元日",
  "2027-01-11": "成人の日",
  "2027-02-11": "建国記念の日",
  "2027-02-23": "天皇誕生日",
  "2027-03-21": "春分の日",
  "2027-03-22": "振替休日",
  "2027-04-29": "昭和の日",
  "2027-05-03": "憲法記念日",
  "2027-05-04": "みどりの日",
  "2027-05-05": "こどもの日",
  "2027-07-19": "海の日",
  "2027-08-11": "山の日",
  "2027-09-20": "敬老の日",
  "2027-09-23": "秋分の日",
  "2027-10-11": "スポーツの日",
  "2027-11-03": "文化の日",
  "2027-11-23": "勤労感謝の日",
};

const ALL_HOLIDAYS: Record<string, string> = {
  ...HOLIDAYS_2026,
  ...HOLIDAYS_2027,
};

/** Returns the Japanese name of the holiday on `dateISO` (YYYY-MM-DD), or null. */
export function holidayName(dateISO: string): string | null {
  return ALL_HOLIDAYS[dateISO] ?? null;
}

/** True when the date is Sat/Sun or a national holiday. */
export function isOffDay(dateISO: string): boolean {
  if (holidayName(dateISO)) return true;
  const wd = new Date(dateISO).getDay();
  return wd === 0 || wd === 6;
}
