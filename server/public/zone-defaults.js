// Heart rate zone defaults for an age (pure; metrics/zones.js and the Settings card both use it). Each zone is saved by
// its top: Zone 1 ends one below Zone 2's low end, and every later zone starts one above the zone before, so the zones
// never leave a gap. A top left unset takes the age default here.

/** Estimated maximum heart rate, 208 - 0.7 x age, rounded; null without a birth year. */
export const maxHrFor = (birthYear, year) => (birthYear > 1900 ? Math.round(208 - 0.7 * (year - birthYear)) : null);

/**
 * The tops of Zones 3 and 4 for a Zone 2 top, filling only what is not set. Unset both, Zones 3 to 5 split the span from
 * Zone 2's top to the maximum evenly; with only Zone 3 set, Zone 4 tops halfway from it to the maximum; with only Zone 4
 * set, Zone 3 tops halfway between Zone 2 and Zone 4. Null when an unset top needs the maximum and there is none.
 * @param {{ maxHr: number|null, zone2High: number, zone3High?: number|null, zone4High?: number|null }} p
 * @returns {{ zone3High: number, zone4High: number } | null}
 */
export function upperTops({ maxHr, zone2High, zone3High = null, zone4High = null }) {
  if (zone3High != null && zone4High != null) return { zone3High, zone4High };
  if (zone4High != null) return { zone3High: Math.round((zone2High + zone4High) / 2), zone4High };
  if (!(maxHr > 0)) return null;
  if (zone3High != null) {
    const top = Math.max(maxHr, zone3High + 2); // always room for Zone 4
    return { zone3High, zone4High: Math.round(zone3High + (top - zone3High) / 2) };
  }
  const top = Math.max(maxHr, zone2High + 3); // always room for Zones 3 to 5
  const step = (top - zone2High) / 3;
  return { zone3High: Math.round(zone2High + step), zone4High: Math.round(zone2High + 2 * step) };
}

/** The suggested Zone 2 for an age: 60% to 70% of the estimated maximum. */
export const zone2Default = (maxHr) => (maxHr > 0 ? { low: Math.round(maxHr * 0.6), high: Math.round(maxHr * 0.7) } : null);

/**
 * Why a set of tops is not usable, or null: each must be above the one before (so every zone holds at least one bpm).
 * Unset tops are left out of the check; their defaults always fit.
 */
export function zoneOrderProblem({ zone2Low, zone2High, zone3High = null, zone4High = null }) {
  const steps = [["Zone 2's low end", zone2Low], ["Zone 2's top", zone2High], ["Zone 3's top", zone3High], ["Zone 4's top", zone4High]]
    .filter(([, v]) => v != null);
  for (let i = 1; i < steps.length; i += 1) {
    if (!(steps[i][1] > steps[i - 1][1])) return `${steps[i][0]} must be above ${steps[i - 1][0]}`;
  }
  // Zone 4 alone: Zone 3 sits halfway, so Zone 4 needs room for it.
  if (zone3High == null && zone4High != null && zone2High != null && zone4High < zone2High + 2) return "Zone 4's top must be at least 2 above Zone 2's top";
  return null;
}
