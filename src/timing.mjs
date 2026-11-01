// Symbolic timing: the one part of the corpus that is not derivable by reading it.
//
// Everything else in this repo answers "what does the corpus say". This answers "what is true right
// now" — the planetary day, the planetary hour, the moon's phase, the season, the nearest sabbat —
// and then scores the corpus's 49 core workings against those conditions.
//
// The solar calculation is a port of the website's `src/utils/solarCalculations.ts` (NOAA
// algorithms), deliberately kept identical rather than improved, so that a question asked here and
// the same question asked at ensoul.so/grimoire/hour cannot disagree. If you find a bug in one,
// fix both.
//
// Two honesty rules, both inherited from the corpus's own:
//
// 1. **Say how the answer was reached.** Without a latitude and longitude the day is divided at a
//    flat 6am/6pm in the *server's* time zone, which is only near the caller's if the caller is near
//    the server. Every timing response carries `basis: 'location' | 'approximation'` rather than
//    silently mixing them.
// 2. **The moon phase is an approximation**, computed from the mean synodic month. It is good to
//    about a day. It is fine for "which phase are we in", and it is not an ephemeris.

export const CHALDEAN_ORDER = ['saturn', 'jupiter', 'mars', 'sun', 'venus', 'mercury', 'moon'];

const SYNODIC_MONTH = 29.530588853;
/** A known new moon: 2000-01-06 18:14 UTC. */
const NEW_MOON_EPOCH = Date.UTC(2000, 0, 6, 18, 14, 0);

// --- whose clock is it? ---------------------------------------------------------------------------
//
// Everything below that says "morning", "Saturday", "spring" or "31 October" is a *wall-clock*
// judgement, and a wall clock belongs to a place. Until 2026-11-01 this module quietly used the
// runtime's own zone, which was correct on a laptop and wrong on the droplet: the server runs UTC,
// so a Sydney caller asking at 20:00 was told "morning", and a window on 1 November was labelled
// with October's season. A caller can now name the zone; if they do not, we fall back to the
// server's and the response says so.

/** The zone the runtime believes it is in — the fallback when the caller names none. */
export const SERVER_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const zoneFormatters = new Map();

function formatterFor(timeZone) {
  const zone = timeZone ?? SERVER_TIME_ZONE;
  let f = zoneFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      weekday: 'long',
    });
    zoneFormatters.set(zone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone.trim()) return false;
  try {
    formatterFor(timeZone).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock pieces of an instant, in a zone. */
export function zoneParts(date, timeZone) {
  const parts = Object.fromEntries(
    formatterFor(timeZone).formatToParts(date).map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    weekday: String(parts.weekday).toLowerCase(),
  };
}

/** A calendar date as a UTC-midnight number, for counting whole days across any zone. */
function dayNumber({ year, month, day }) {
  return Date.UTC(year, month - 1, day);
}

const toRadians = (d) => (d * Math.PI) / 180;
const toDegrees = (r) => (r * 180) / Math.PI;

/** Sunrise and sunset for a date and place. Port of the site's NOAA implementation. */
export function sunTimes(date, latitude, longitude) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();

  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  const jdn =
    day +
    Math.floor((153 * m + 2) / 5) +
    365 * y +
    Math.floor(y / 4) -
    Math.floor(y / 100) +
    Math.floor(y / 400) -
    32045;

  const julianDay = jdn - 0.5;
  const jc = (julianDay - 2451545.0) / 36525.0;

  const geomMeanLongSun = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360;
  const geomMeanAnomSun = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
  const eccentEarthOrbit = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);

  const sunEqOfCtr =
    Math.sin(toRadians(geomMeanAnomSun)) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) +
    Math.sin(toRadians(2 * geomMeanAnomSun)) * (0.019993 - 0.000101 * jc) +
    Math.sin(toRadians(3 * geomMeanAnomSun)) * 0.000289;

  const sunTrueLong = geomMeanLongSun + sunEqOfCtr;
  const sunAppLong =
    sunTrueLong - 0.00569 - 0.00478 * Math.sin(toRadians(125.04 - 1934.136 * jc));

  const meanObliqEcliptic =
    23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
  const obliqCorr = meanObliqEcliptic + 0.00256 * Math.cos(toRadians(125.04 - 1934.136 * jc));
  const sunDeclin = toDegrees(
    Math.asin(Math.sin(toRadians(obliqCorr)) * Math.sin(toRadians(sunAppLong))),
  );

  const varY = Math.tan(toRadians(obliqCorr / 2)) ** 2;
  const eqOfTime =
    4 *
    toDegrees(
      varY * Math.sin(2 * toRadians(geomMeanLongSun)) -
        2 * eccentEarthOrbit * Math.sin(toRadians(geomMeanAnomSun)) +
        4 * eccentEarthOrbit * varY * Math.sin(toRadians(geomMeanAnomSun)) *
          Math.cos(2 * toRadians(geomMeanLongSun)) -
        0.5 * varY * varY * Math.sin(4 * toRadians(geomMeanLongSun)) -
        1.25 * eccentEarthOrbit * eccentEarthOrbit * Math.sin(2 * toRadians(geomMeanAnomSun)),
    );

  const zenith = 90.833;
  const cosH =
    Math.cos(toRadians(zenith)) / (Math.cos(toRadians(latitude)) * Math.cos(toRadians(sunDeclin))) -
    Math.tan(toRadians(latitude)) * Math.tan(toRadians(sunDeclin));

  // Above the polar circle the sun may not rise or set at all; there is no honest hour system, so
  // say so instead of returning NaN times.
  if (cosH > 1 || cosH < -1) return null;
  const hourAngle = toDegrees(Math.acos(cosH));

  const tzOffsetHours = -date.getTimezoneOffset() / 60;
  const solarNoonLocal = 720 - 4 * longitude - eqOfTime + tzOffsetHours * 60;
  const sunriseMinutes = solarNoonLocal - hourAngle * 4;
  const sunsetMinutes = solarNoonLocal + hourAngle * 4;

  const at = (minutes) => {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setMinutes(minutes);
    return d;
  };

  return { sunrise: at(sunriseMinutes), sunset: at(sunsetMinutes) };
}

export function dayOfWeek(date, timeZone) {
  if (timeZone) return zoneParts(date, timeZone).weekday;
  return ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][date.getDay()];
}

/**
 * A calendar date as YYYY-MM-DD in a named zone, or the runtime's own when none is given.
 *
 * `toISOString().slice(0, 10)` is the obvious way to do this and it is wrong east of UTC: Samhain
 * at local midnight on 31 October is 30 October in UTC, so every sabbat was reported a day early in
 * Sydney. A festival's date is a calendar fact for a place, not an instant.
 */
function ymd(date, timeZone) {
  if (timeZone) {
    const p = zoneParts(date, timeZone);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  }
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The planet that rules a weekday, read from the corpus's own `weekdays.json`. */
export function planetaryDayPlanet(corpus, date, timeZone) {
  const day = dayOfWeek(date, timeZone);
  const entry = corpus.collectionByFile.get('weekdays.json')?.entryById.get(day);
  const planet = entry?.planetary_ruler?.planet ?? entry?.planet?.id ?? entry?.planet;
  if (typeof planet === 'string') return planet;
  // Fall back to the received order rather than failing: Sunday is the Sun, Monday the Moon, and
  // so on, which is also what the corpus says.
  return ['sun', 'moon', 'mars', 'mercury', 'jupiter', 'venus', 'saturn'][date.getDay()];
}

/**
 * The 24 planetary hours of a day, sunrise to sunrise.
 *
 * The day's ruler sets the first hour; the hours then step through the Chaldean order. Day hours
 * are one twelfth of daylight and night hours one twelfth of darkness, so they are equal only at
 * the equinox — which is the part most implementations get wrong.
 */
export function planetaryHours(corpus, date, { latitude, longitude, timeZone } = {}) {
  const hasLocation =
    typeof latitude === 'number' && typeof longitude === 'number' && Number.isFinite(latitude);
  const today = hasLocation ? sunTimes(date, latitude, longitude) : null;
  const tomorrow = hasLocation
    ? sunTimes(new Date(date.getTime() + 86400000), latitude, longitude)
    : null;

  let sunrise;
  let sunset;
  let nextSunrise;
  if (today && tomorrow) {
    sunrise = today.sunrise;
    sunset = today.sunset;
    nextSunrise = tomorrow.sunrise;
  } else {
    sunrise = new Date(date);
    sunrise.setHours(6, 0, 0, 0);
    sunset = new Date(date);
    sunset.setHours(18, 0, 0, 0);
    nextSunrise = new Date(sunrise.getTime() + 86400000);
  }

  const dayLen = (sunset.getTime() - sunrise.getTime()) / 12;
  const nightLen = (nextSunrise.getTime() - sunset.getTime()) / 12;

  const ruler = planetaryDayPlanet(corpus, date, timeZone);
  const startIndex = Math.max(0, CHALDEAN_ORDER.indexOf(ruler));
  const planetFor = (i) => CHALDEAN_ORDER[(startIndex + i) % 7];

  const now = Date.now();
  const hours = [];
  for (let i = 0; i < 12; i += 1) {
    const start = new Date(sunrise.getTime() + i * dayLen);
    const end = new Date(start.getTime() + dayLen);
    hours.push({
      number: i + 1,
      day: true,
      planet: planetFor(i),
      start,
      end,
      current: now >= start.getTime() && now < end.getTime(),
    });
  }
  for (let i = 0; i < 12; i += 1) {
    const start = new Date(sunset.getTime() + i * nightLen);
    const end = new Date(start.getTime() + nightLen);
    hours.push({
      number: i + 13,
      day: false,
      planet: planetFor(i + 12),
      start,
      end,
      current: now >= start.getTime() && now < end.getTime(),
    });
  }

  return {
    basis: hasLocation ? 'location' : 'approximation',
    sunrise,
    sunset,
    dayRuler: ruler,
    hours,
    current: hours.find((h) => h.current) ?? null,
  };
}

/**
 * The moon's phases as age windows, in days since astronomical new moon.
 *
 * One table, used by both `moonPhase` (which phase is it *now*) and `nextMoonPhase` (when is the
 * next one). The corpus's phase ids are the authority; the boundaries are the ones the website's
 * moon widget has always used, and they are symmetric about the four cardinal instants —
 * new 0 d, first quarter 7.38 d, full 14.77 d, last quarter 22.15 d — which is what lets a "next
 * full moon" be computed from the same numbers that decide "which phase are we in".
 */
export const MOON_PHASES = [
  { id: 'new_moon', display: 'New Moon', lower: 0, upper: 1.0 },
  { id: 'waxing_crescent', display: 'Waxing Crescent', lower: 1.0, upper: 6.38 },
  { id: 'first_quarter', display: 'First Quarter', lower: 6.38, upper: 8.38 },
  { id: 'waxing_gibbous', display: 'Waxing Gibbous', lower: 8.38, upper: 13.76 },
  { id: 'full_moon', display: 'Full Moon', lower: 13.76, upper: 15.76 },
  { id: 'waning_gibbous', display: 'Waning Gibbous', lower: 15.76, upper: 21.15 },
  { id: 'last_quarter', display: 'Last Quarter', lower: 21.15, upper: 23.15 },
  { id: 'waning_crescent', display: 'Waning Crescent', lower: 23.15, upper: 28.53 },
  { id: 'new_moon', display: 'New Moon', lower: 28.53, upper: SYNODIC_MONTH },
];

/** Days since astronomical new moon, on the mean synodic month. */
function moonAge(date) {
  const days = (date.getTime() - NEW_MOON_EPOCH) / 86400000;
  return ((days % SYNODIC_MONTH) + SYNODIC_MONTH) % SYNODIC_MONTH;
}

/** Mean-synodic-month approximation of the moon's phase, mapped onto the corpus's phase ids. */
export function moonPhase(date = new Date()) {
  const age = moonAge(date);
  const found = MOON_PHASES.find((p) => age < p.upper) ?? MOON_PHASES[MOON_PHASES.length - 1];
  const illumination = (1 - Math.cos((2 * Math.PI * age) / SYNODIC_MONTH)) / 2;
  return {
    id: found.id,
    display: found.display,
    age_days: Number(age.toFixed(2)),
    illumination: Number((illumination * 100).toFixed(1)),
    approximation: 'mean synodic month; accurate to about a day',
  };
}

/**
 * When the mean synodic age next reaches the middle of a phase's window.
 *
 * The middle, not the start, because the middle is the traditional instant: conjunction for the new
 * moon, opposition for the full. The response always carries that caveat, because a mean synodic
 * model is accurate to roughly a day and will not match an almanac to the hour.
 */
export function nextMoonPhase(date, id) {
  const wanted = String(id).trim().toLowerCase();
  const phase = MOON_PHASES.find((p) => p.id === wanted);
  if (!phase) return null;

  // New moon wraps the cycle, so its middle is 0 rather than the midpoint of 28.53–29.53.
  const centre = wanted === 'new_moon' ? 0 : (phase.lower + phase.upper) / 2;
  const age = moonAge(date);
  let delta = centre - age;
  if (delta < 0) delta += SYNODIC_MONTH;

  const instant = new Date(date.getTime() + delta * 86400000);
  const illumination = (1 - Math.cos((2 * Math.PI * centre) / SYNODIC_MONTH)) / 2;
  return {
    id: phase.id,
    display: phase.display,
    date: instant.toISOString(),
    days_away: Number(delta.toFixed(2)),
    illumination: Number((illumination * 100).toFixed(1)),
  };
}

export function season(date = new Date(), hemisphere = 'northern', timeZone) {
  const month = timeZone ? zoneParts(date, timeZone).month : date.getMonth() + 1;
  const north =
    month >= 3 && month <= 5
      ? 'spring'
      : month >= 6 && month <= 8
        ? 'summer'
        : month >= 9 && month <= 11
          ? 'autumn'
          : 'winter';
  if (hemisphere === 'northern') return north;
  return { spring: 'autumn', summer: 'winter', autumn: 'spring', winter: 'summer' }[north];
}

export function timeOfDay(date = new Date(), timeZone) {
  const h = timeZone ? zoneParts(date, timeZone).hour : date.getHours();
  if (h >= 5 && h < 9) return 'dawn';
  if (h >= 9 && h < 12) return 'morning';
  if (h === 12) return 'noon';
  if (h > 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 20) return 'dusk';
  if (h >= 20 && h < 24) return 'evening';
  if (h === 0) return 'midnight';
  return 'night';
}

/**
 * The eight fixed sabbat dates, by month and day.
 *
 * They are the fixed ones the corpus uses; the astronomical quarter-days drift by a day or so year
 * to year, and the corpus's own entries say so. The point of the fixed dates is that two surfaces
 * agree on which day the festival falls, not that it is astronomically exact.
 */
const SABBAT_DATES = {
  samhain: [10, 31],
  yule: [12, 21],
  imbolc: [2, 1],
  ostara: [3, 20],
  beltane: [5, 1],
  litha: [6, 21],
  lughnasadh: [8, 1],
  mabon: [9, 22],
};

/**
 * Every sabbat whose date falls between two moments, in order.
 *
 * The dates are the fixed ones the corpus uses; the astronomical quarter-days drift by a day or so
 * year to year, and the corpus's own entries say so. Years either side of the range are scanned
 * because a window can straddle a year boundary — a 30-day look-ahead from 20 December must find
 * Yule *and* Imbolc.
 *
 * A sabbat is a calendar date, so the comparison is between calendar dates in the caller's zone,
 * not between instants: a festival does not begin at midnight UTC for everyone.
 */
export function sabbatsInRange(corpus, from = new Date(), to = new Date(from.getTime() + 30 * 86400000), timeZone) {
  const fromDay = dayNumber(zoneParts(from, timeZone));
  const toDay = dayNumber(zoneParts(to, timeZone));
  const fromYear = zoneParts(from, timeZone).year;
  const toYear = zoneParts(to, timeZone).year;

  const found = [];
  for (const [id, [month, day]] of Object.entries(SABBAT_DATES)) {
    for (let y = fromYear - 1; y <= toYear + 1; y += 1) {
      const dayAt = Date.UTC(y, month - 1, day);
      if (dayAt < fromDay || dayAt > toDay) continue;
      const entry = corpus.collectionByFile.get('sabbats.json')?.entryById.get(id);
      found.push({
        id,
        name: entry?.name ?? id,
        date: `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        day: dayAt,
        days_away: Math.round((dayAt - fromDay) / 86400000),
        themes: entry?.themes ?? [],
        ritual_focus: entry?.ritual_focus ?? null,
        source: entry ? 'sabbats.json' : null,
      });
    }
  }

  return found.sort((a, b) => a.day - b.day);
}

export function nearbySabbat(corpus, date = new Date(), windowDays = 7, timeZone) {
  const from = new Date(date.getTime() - windowDays * 86400000);
  const to = new Date(date.getTime() + windowDays * 86400000);
  const today = dayNumber(zoneParts(date, timeZone));

  let best = null;
  for (const s of sabbatsInRange(corpus, from, to, timeZone)) {
    const daysAway = Math.round((s.day - today) / 86400000);
    if (!best || Math.abs(daysAway) < Math.abs(best.daysAway)) best = { s, daysAway };
  }
  if (!best) return null;

  const { day, ...rest } = best.s;
  return { ...rest, days_away: best.daysAway };
}

/** Where a whole timing snapshot starts: everything above, for one moment. */
export function timingSnapshot(corpus, { date = new Date(), latitude, longitude, hemisphere, timeZone } = {}) {
  const hours = planetaryHours(corpus, date, { latitude, longitude, timeZone });
  const north =
    hemisphere === 'southern' ? 'southern' : typeof latitude === 'number' && latitude < 0 ? 'southern' : 'northern';
  return {
    at: date.toISOString(),
    basis: hours.basis,
    planetary_day: hours.dayRuler,
    planetary_hour: hours.current
      ? { number: hours.current.number, day: hours.current.day, planet: hours.current.planet }
      : null,
    sunrise: hours.sunrise.toISOString(),
    sunset: hours.sunset.toISOString(),
    moon: moonPhase(date),
    season: season(date, north, timeZone),
    time_of_day: timeOfDay(date, timeZone),
    sabbat: nearbySabbat(corpus, date, 7, timeZone),
    hours: hours.hours.map((h) => ({
      number: h.number,
      day: h.day,
      planet: h.planet,
      start: h.start.toISOString(),
      end: h.end.toISOString(),
      current: h.current,
    })),
    caveats: [
      hours.basis === 'approximation'
        ? "No latitude/longitude supplied: the day was divided at a flat 6am/6pm in *the server's* time zone. That is only a couple of hours out if the caller is near the server; otherwise it can be many hours out. Supply latitude and longitude for an honest hour boundary."
        : 'Sunrise and sunset computed for the supplied latitude/longitude.',
      `Clock and calendar judgements — weekday, time of day, season, sabbat dates — are evaluated in ${
        timeZone ?? SERVER_TIME_ZONE
      }${timeZone ? '' : " (the server's zone; pass `time_zone` for yours)"}.`,
      'Moon phase is computed from the mean synodic month, accurate to about a day.',
    ],
  };
}

const normalise = (s) =>
  String(s ?? '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Score the corpus's workings against a set of conditions.
 *
 * Ported from the website's `scoreWorkings` so both surfaces rank identically. Weights are the
 * site's: day 25, moon 25 (and −10 if the phase is one the working says to avoid), hour 20,
 * season 15, moon-sign 10, time of day 10, plus a 15-point sabbat bonus when a theme overlaps.
 *
 * One deliberate difference: if no moon sign is supplied the sign factor is *skipped* rather than
 * scored as a miss. The site always has the sign; a caller here may not, and silently marking an
 * unknown as a failure would rank every working down by the same 10 points.
 */
export function scoreWorkings(workings, conditions) {
  const { dayOfWeek: dow, moonPhase: phase, moonPhaseDisplay, moonSign, planetaryHourPlanet, season: seasonName, timeOfDay: tod, sabbat } = conditions;

  return workings
    .map((working) => {
      const t = working.optimal_timing ?? {};
      const factors = [];
      let score = 0;
      let maxScore = 0;
      const tally = (name, weight, matched) => {
        maxScore += weight;
        if (matched) score += weight;
        factors.push({ name, weight, matched, points: matched ? weight : 0 });
      };

      tally('Day', 25, (t.days ?? []).includes(dow));
      const avoid = (t.avoid_phases ?? []).includes(phase);
      if (avoid) {
        maxScore += 25;
        score -= 10;
        factors.push({ name: 'Moon', weight: 25, matched: false, points: -10, avoid: true });
      } else if ((t.moon_phases ?? []).length) {
        // Only scored when the entry actually states a moon election. A talisman names a day and an
        // hour and says nothing about the moon; counting that silence as a miss would rank it down
        // for information the corpus never had.
        tally('Moon', 25, t.moon_phases.includes(phase));
      }
      tally('Hour', 20, (t.planetary_hours ?? []).includes(planetaryHourPlanet));
      if ((t.best_seasons ?? []).length) tally('Season', 15, t.best_seasons.includes(seasonName));
      if ((t.zodiac_signs ?? []).length && moonSign) {
        tally('Sign', 10, t.zodiac_signs.includes(String(moonSign).toLowerCase()));
      }
      if ((t.time_of_day ?? []).length) tally('Time', 10, t.time_of_day.includes(tod));

      if (sabbat) {
        const themes = (sabbat.themes ?? []).map((s) => s.toLowerCase());
        const kws = (working.keywords ?? []).map((k) => k.toLowerCase());
        const sabWork = (sabbat.ritual_focus?.workings ?? []).map((s) => s.toLowerCase());
        const overlap =
          themes.some((th) => kws.some((kw) => th.includes(kw) || kw.includes(th))) ||
          sabWork.some((sw) => kws.some((kw) => sw.includes(kw) || kw.includes(sw)));
        if (overlap) {
          maxScore += 15;
          score += 15;
          factors.push({ name: 'Sabbat', weight: 15, matched: true, points: 15 });
        }
      }

      return {
        id: working.id,
        name: working.name,
        category: working.category,
        score,
        maxScore,
        percentage: maxScore > 0 ? Math.max(0, Math.round((score / maxScore) * 100)) : 0,
        factors,
        detail: {
          best_days: (t.days ?? []).map(normalise),
          best_phases: (t.moon_phases ?? []).map(normalise),
          best_hours: (t.planetary_hours ?? []).map(normalise),
        },
      };
    })
    .sort((a, b) => b.percentage - a.percentage);
}

/**
 * The next hour of a given planet, from a moment forward.
 *
 * Each of the seven appears three or four times in a day, so this is always found within a day; the
 * `maxDays` bound exists so a caller who asks for something that is not a planet gets null rather
 * than an unbounded scan. `daylightOnly` is the common practical ask — a Venus hour at 3am is
 * technically correct and useless to someone who wants to do the work before dinner.
 */
export function nextPlanetaryHour(
  corpus,
  planet,
  { from = new Date(), latitude, longitude, maxDays = 7, daylightOnly = false, timeZone } = {},
) {
  const wanted = String(planet).trim().toLowerCase();

  for (let d = 0; d < maxDays; d += 1) {
    const day = new Date(from);
    day.setDate(day.getDate() + d);
    const hours = planetaryHours(corpus, day, { latitude, longitude, timeZone });

    for (const h of hours.hours) {
      // On the first day, only hours that have not started yet; later days are entirely ahead.
      if (d === 0 && h.start.getTime() < from.getTime()) continue;
      if (daylightOnly && !h.day) continue;
      if (h.planet !== wanted) continue;

      return {
        planet: h.planet,
        number: h.number,
        day: h.day,
        start: h.start.toISOString(),
        end: h.end.toISOString(),
        hours_away: Number(((h.start.getTime() - from.getTime()) / 3600000).toFixed(1)),
      };
    }
  }
  return null;
}

/**
 * When a working fits best over a horizon.
 *
 * The corpus states a working's timing as an election — days, phases, hours, seasons, signs — so
 * "when should I do this" is a search over future days, not a guess. Every planetary hour in the
 * horizon is scored, and the best hour of each day is kept: returning the top thirty hours
 * outright would answer the question with a pile of adjacent afternoons rather than a window.
 *
 * Percentages are comparable within one response, not across questions: the moon-sign factor is
 * skipped (there is no ephemeris here), so every working's maximum is 10 points lower than the
 * website's.
 */
export function workingWindows(
  corpus,
  working,
  { from = new Date(), days = 30, latitude, longitude, hemisphere, limit = 5, timeZone } = {},
) {
  const end = new Date(from.getTime() + days * 86400000);
  const perDay = [];

  for (let d = 0; d < days; d += 1) {
    const day = new Date(from);
    day.setDate(day.getDate() + d);
    const snap = timingSnapshot(corpus, { date: day, latitude, longitude, hemisphere, timeZone });

    let best = null;
    for (const h of snap.hours) {
      const start = new Date(h.start);
      if (d === 0 && start.getTime() < from.getTime()) continue;
      if (start > end) continue;

      const conditions = {
        // The weekday of the *instant*, not of the planetary cycle it belongs to. A 5am hour is
        // still inside the previous sunrise-to-sunrise cycle, but `fits` scores the calendar
        // weekday (as the website does), so scoring the cycle here would make the two verbs
        // disagree about the same moment. `weekday` is echoed so the answer explains itself.
        dayOfWeek: dayOfWeek(start, timeZone),
        moonPhase: snap.moon.id,
        planetaryHourPlanet: h.planet,
        season: snap.season,
        timeOfDay: timeOfDay(start, timeZone),
        sabbat: snap.sabbat,
      };
      const scored = scoreWorkings([working], conditions)[0];
      if (!best || scored.percentage > best.percentage) {
        best = {
          date: ymd(start, timeZone),
          start: h.start,
          end: h.end,
          hour: { number: h.number, day: h.day, planet: h.planet },
          percentage: scored.percentage,
          score: scored.score,
          matched: scored.factors.filter((f) => f.matched).map((f) => f.name),
          conditions: {
            weekday: dayOfWeek(start, timeZone),
            planetary_day: snap.planetary_day,
            moon_phase: snap.moon.id,
            season: snap.season,
            sabbat: snap.sabbat?.id ?? null,
          },
        };
      }
    }
    if (best) perDay.push(best);
  }

  return perDay
    .sort((a, b) => b.percentage - a.percentage || a.start.localeCompare(b.start))
    .slice(0, limit);
}
