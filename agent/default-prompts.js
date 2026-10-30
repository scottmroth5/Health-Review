// The prompt sections a new user starts with (multi-user, phase 2): generic, none sensitive, and never copied from
// anyone else's. They edit them on the Prompt tab.
export const DEFAULT_PROMPT_SECTIONS = [
  ['About me', 'Edit me: your age, your goals for the next few months (for example more strength, better sleep, a lower resting heart rate), and anything the review should keep in mind. Today is {{TODAY}}.'],
  ['Coaching style', 'Be practical and specific, in plain language. The review opens with the week\'s biggest changes and next steps on its own; after that, cover recovery, training and anything to watch. Keep the review under 2,000 words.'],
  ['Training', 'Edit me: how many days a week you lift, the equipment you have, and any exercises to avoid.'],
];

/** Gives a user the default sections when they have none (approval, or a user who deleted them all keeps none). */
export function addDefaultPromptSections(db, now = new Date().toISOString()) {
  if (db.prepare('SELECT COUNT(*) FROM prompt_sections WHERE user_id = @uid').pluck().get()) return 0;
  const insert = db.prepare('INSERT INTO prompt_sections (user_id, position, name, text, sensitive, updated_at) VALUES (@uid, ?, ?, ?, 0, ?)');
  DEFAULT_PROMPT_SECTIONS.forEach(([name, text], i) => insert.run(i + 1, name, text, now));
  return DEFAULT_PROMPT_SECTIONS.length;
}
