const SECTION_NAME = /^(\d+)_/;

/**
 * Sort position of a prompt section from its name ("01_profile.md" is 1), or null when the
 * name has no numeric prefix and is not a section.
 * @param {string} name
 * @returns {number|null}
 */
export function sectionOrder(name) {
  const match = SECTION_NAME.exec(name);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * The weekly review's instructions from stored prompt sections (prompt_sections rows), in
 * position order. Sensitive sections (medications, genetics) are left out unless a caller
 * that needs them for a specific question passes includeSensitive.
 *
 * @param {Array<{position: number, name: string, text: string, sensitive: number|boolean}>} sections
 * @param {string} today  run date as yyyy-MM-dd
 * @param {{ includeSensitive?: boolean }} [options]
 */
export function buildInstructions(sections, today, { includeSensitive = false } = {}) {
  return assembleSections(
    sections.filter((s) => includeSensitive || !s.sensitive).map((s) => ({ name: `${s.position}_${s.name}`, text: s.text })),
    today,
  );
}

/**
 * Joins prompt sections the way v1 did: numeric order (so 10 follows 2), blank line between
 * sections, and every {{TODAY}} replaced with the run date. Names without a numeric prefix
 * are ignored.
 *
 * @param {Array<{name: string, text: string}>} sections
 * @param {string} today  run date as yyyy-MM-dd
 * @returns {string}
 */
export function assembleSections(sections, today) {
  return sections
    .map((s) => ({ ...s, order: sectionOrder(s.name) }))
    .filter((s) => s.order !== null)
    .sort((a, b) => a.order - b.order)
    .map((s) => s.text)
    .join('\n\n')
    .replaceAll('{{TODAY}}', today);
}
