// Demo mode: a per-browser switch for showing the app to other people. It hides drinking data on screen only
// (the Drinks box on Today, the alcohol chart on Health, and drinking in review text); nothing stored changes.
// No DOM here, so the review filter is tested with node:test.

export const DEMO_KEY = 'healthReview.demoMode';

// Words that mark a line as about drinking. CBD is logged in the Drinks box but is not alcohol, so it stays.
const DRINKING = /\b(drinks?|drinking|drank|alcohol(ic)?|beers?|wines?|bourbon|whiskey|liquor|cocktails?|booze|hangovers?|sober|sobriety)\b/i;

/** True when demo mode is on: ?demo=1 in the address turns it on (and ?demo=0 off), else the saved choice. */
export function demoFromLocation(search, storage) {
  const param = new URLSearchParams(search ?? '').get('demo');
  if (param === '1' || param === '0') return param === '1';
  try {
    return storage?.getItem(DEMO_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The review Markdown without drinking: sections titled about drinking are dropped whole, and in the other
 * sections any paragraph or bullet that mentions drinking is dropped. A section left with no text is dropped.
 */
export function redactReview(md) {
  const blocks = String(md ?? '').split(/^(?=## )/m);
  const out = [];
  for (const block of blocks) {
    const [first, ...rest] = block.split('\n');
    const isSection = first.startsWith('## ');
    if (isSection && DRINKING.test(first)) continue;
    const lines = (isSection ? rest : [first, ...rest]).filter((line) => !DRINKING.test(line));
    if (isSection && !lines.some((l) => l.trim())) continue;
    out.push(isSection ? [first, ...lines].join('\n') : lines.join('\n'));
  }
  return out.join('').replace(/\n{3,}/g, '\n\n');
}

export const isDrinkingChart = (chart) => chart.from === 'drinking';
