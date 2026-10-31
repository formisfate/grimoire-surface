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
//    flat 6am/6pm, which is wrong by up to a couple of hours at high latitudes. Every timing
//    response carries `basis: 'location' | 'approximation'` rather than silently mixing them.
// 2. **The moon phase is an approximation**, computed from the mean synodic month. It is good to
//    about a day. It is fine for "which phase are we in", and it is not an ephemeris.

export const CHALDEAN_ORDER = ['saturn', 'jupiter', 'mars', 'sun', 'venus', 'mercury', 'moon'];

const SYNODIC_MONTH = 29.530588853;
/** A known new moon: 2000-01-06 18:14 UTC. */
const NEW_MOON_EPOCH = Date.UTC(2000, 0, 6, 18, 14, 0);

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

export function dayOfWeek(date) {
  return ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][date.getDay()];
}

/** The planet that rules a weekday, read from the corpus's own `weekdays.json`. */
export function planetaryDayPlanet(corpus, date) {
  const day = dayOfWeek(date);
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
export function planetaryHours(corpus, date, { latitude, longitude } = {}) {
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

  const ruler = planetaryDayPlanet(corpus, date);
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

/** Mean-synodic-month approximation of the moon's phase, mapped onto the corpus's phase ids. */
export function moonPhase(date = new Date()) {
  const days = (date.getTime() - NEW_MOON_EPOCH) / 86400000;
  const age = ((days % SYNODIC_MONTH) + SYNODIC_MONTH) % SYNODIC_MONTH;
  const bounds = [
    [1.0, 'new_moon', 'New Moon'],
    [6.38, 'waxing_crescent', 'Waxing Crescent'],
    [8.38, 'first_quarter', 'First Quarter'],
    [13.76, 'waxing_gibbous', 'Waxing Gibbous'],
    [15.76, 'full_moon', 'Full Moon'],
    [21.15, 'waning_gibbous', 'Waning Gibbous'],
    [23.15, 'last_quarter', 'Last Quarter'],
    [28.53, 'waning_crescent', 'Waning Crescent'],
    [SYNODIC_MONTH, 'new_moon', 'New Moon'],
  ];
  const [, id, display] = bounds.find(([limit]) => age < limit) ?? bounds[bounds.length - 1];
  const illumination = (1 - Math.cos((2 * Math.PI * age) / SYNODIC_MONTH)) / 2;
  return {
    id,
    display,
    age_days: Number(age.toFixed(2)),
    illumination: Number((illumination * 100).toFixed(1)),
    approximation: 'mean synodic month; accurate to about a day',
  };
}

export function season(date = new Date(), hemisphere = 'northern') {
  const month = date.getMonth() + 1;
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

export function timeOfDay(date = new Date()) {
  const h = date.getHours();
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
 * The nearest sabbat within `windowDays`, or null.
 *
 * The dates are the fixed ones the corpus uses; the astronomical quarter-days drift by a day or so
 * year to year, and the corpus's own entries say so.
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

export function nearbySabbat(corpus, date = new Date(), windowDays = 7) {
  const year = date.getFullYear();
  let best = null;

  for (const [id, [month, day]] of Object.entries(SABBAT_DATES)) {
    for (const y of [year - 1, year, year + 1]) {
      const when = new Date(y, month - 1, day);
      const delta = Math.round((when.getTime() - date.getTime()) / 86400000);
      if (Math.abs(delta) <= windowDays && (!best || Math.abs(delta) < Math.abs(best.daysAway))) {
        best = { id, when, daysAway: delta };
      }
    }
  }
  if (!best) return null;

  const entry = corpus.collectionByFile.get('sabbats.json')?.entryById.get(best.id);
  return {
    id: best.id,
    name: entry?.name ?? best.id,
    date: best.when.toISOString().slice(0, 10),
    days_away: best.daysAway,
    themes: entry?.themes ?? [],
    ritual_focus: entry?.ritual_focus ?? null,
    source: entry ? 'sabbats.json' : null,
  };
}

/** Where a whole timing snapshot starts: everything above, for one moment. */
export function timingSnapshot(corpus, { date = new Date(), latitude, longitude, hemisphere } = {}) {
  const hours = planetaryHours(corpus, date, { latitude, longitude });
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
    season: season(date, north),
    time_of_day: timeOfDay(date),
    sabbat: nearbySabbat(corpus, date),
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
        ? 'No latitude/longitude supplied: the day was divided at a flat 6am/6pm, so the hour boundaries can be off by a couple of hours.'
        : 'Sunrise and sunset computed for the supplied latitude/longitude.',
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
      } else {
        tally('Moon', 25, (t.moon_phases ?? []).includes(phase));
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
