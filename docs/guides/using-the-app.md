# Using Health Review

Health Review shows your own health and training data back to you, with a weekly review if you use AI. Everything starts from **Home**, a tile for each part of the app. On a wide screen the same parts are tabs along the top.

## The tiles

- **Daily Check-in:** the day's check-in (readiness, energy, mood, stress, nutrition on 1 to 10, optional weight and body measurements, a note), your medications and supplements to tick off, and drinks. Use the arrows to go back to an earlier day.
- **Training:** **Log workout** (record a session in the app, no sheet needed), your current program and its phase, training volume by week or month, lift progress (progressing, stalled or regressing within one rep range), the Next program ranking with its goal weights, and "called for vs logged".
- **Programs:** your own training programs (built in the app, imported as JSON, or read from a PDF by Claude), with the program blocks found in your Workout Log to confirm.
- **Health:** VO2 max, the heart rate zones card, and charts of every Apple Health metric with suggested targets. Its suggested targets use your profile in Settings. Sleeping wrist temperature has no target: its chart shades your usual range and marks nights outside it. The links at the top of Training and Health jump to each card.
- **Meds:** each medication and supplement with its dose and timing; a dose change is a new dated period, so the history shows what changed when.
- **Labs:** lab results by panel, with a range for each test that you can change.
- **Reviews:** the weekly review, written each Sunday morning from the week's computed summary when you use AI. Anything about medications, labs or symptoms is listed only under "Discuss with your physician".
- **Prompt:** the instructions the weekly review follows; edit them to change its tone and focus. Every change keeps the old version.
- **Activity:** status first (when each feed last sent data, and each scheduled job's last result and next run), then what the AI cost, with the full run history under Run history and technical details.
- **Settings:** your goals, your profile (birth year, sex and height, for the suggested targets), your Claude API key, your data feeds (Health Auto Export, the Workout Log sheet), your time zone (it decides your "today" and your review week), and your account: export your data, pause or delete your account.
- **Help:** these guides, Ask for a question about using the app, and Send feedback (feedback, an idea, or a bug report).

## Make it yours

- **Your goals** (Settings): pick a primary goal and an optional second one. Home, Training and Health put that information first, and your weekly review opens with it.
- **Arrange tiles** (under the Home tiles): use the arrows to move tiles, then Done. Reset goes back to the default.
- **Arrange** on Training and Health works the same way for their cards, and on Health for each chart too. Your order is saved to your account, so it is the same on every device.
- **Your prompt** (Prompt tab): Help me write a section drafts a section from a few answers. See [Writing your review prompt](/guides/prompts).

## Sync now

**Sync now** on Home reads your Workout Log sheet straight away. Health Auto Export sends Apple Health data on its own schedule; the last sync time shows next to the button.

## Common questions

- **A day shows red or is missing:** Health Auto Export had not sent the full day yet. It fills in when the next export arrives. A partial day is never treated as a bad day.
- **My workouts have no program:** add the program on **Programs** with match words found in your Workout Log's "Workout" names, then confirm its block.
- **No AI:** add your Claude API key in Settings (see the Claude key guide). Without one, everything except the weekly review, the chat and Ask still works.
- **Stop for a while:** Settings, **Pause my account** stops posts, syncs and AI until you resume. Your data stays.

[All guides](/guides)
