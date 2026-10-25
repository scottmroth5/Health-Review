# Workout Log in Google Sheets

Health Review can read your lifting log from your own Google Sheet: training volume, lift progress, program blocks and phases come from it.

## The easy way: Create my Workout Log

- In **Settings**, then **Data feeds**, tick **Workout Log** and tap **Create my Workout Log**.
- Google asks to let Health Review see your spreadsheets (read only) and create files in your Drive. Health Review can open only the files it created and the sheet you choose, never the rest of your Drive.
- Google may show "Google hasn't verified this app" while the app's review with Google is pending. Choose **Advanced**, then **Go to Health Review**.
- You come back to Settings with a new sheet named **Health Review Workout Log** in your Google Drive, already set up and saved. Tap **Open my Workout Log in Google Sheets** to start logging. Its **How to use** tab repeats the layout below.

Already keep a log in Google Sheets? Use **Connect an existing sheet** instead, and lay it out as below.

## Excel instead

- Don't use Google? In **Settings**, then **Data feeds**, under **Workout Log**, tap **Download the Excel Workout Log**. It has the same columns as below and a **How to use** tab.
- Log your workouts in it in Excel, save it, then choose the file under **Or use Excel** and tap **Upload**. Each upload replaces the years in the file (workouts you logged in the app stay).
- Only Excel workbooks (`.xlsx`) up to 5 MB are accepted. Files with macros (`.xlsm`), old `.xls` files, password-protected workbooks and workbooks linking to other files are refused; save a plain `.xlsx` copy and upload that.
- The file is read once to take your workouts out of it and is not kept. You can upload up to 10 times an hour.
- If you sync a Google Sheet, disconnect it first: the two would overwrite each other.

## The sheet layout

- One **tab per year**, named with the year only: `2025`, `2026`.
- The first row of each tab holds the column names. Health Review reads these columns (others are ignored):
- **Date:** the day of the workout, on the first row of that day (the rows below it are the same day until the next date).
- **Workout:** the workout's name on the day's first row, for example `MAPS Anabolic Phase 2 Day A`. Program names, phases (`Phase 2`) and `Deload` in this name drive the program and phase tracking.
- **Exercise:** one row per exercise, for example `Barbell Squat`.
- **Weight 1, Set 1, Weight 2, Set 2, ...** up to 8 pairs: each pair is one set. Weight is in pounds (`185`, or `BW` for bodyweight, or a band color). Set is the reps (`8`), or a time (`30 seconds`, `:45`).
- **Comment:** optional notes on an exercise.
- Text typed in the Date column (like `Sick` or `Vacation`) is kept as a note for that day.

## Example

- Row 1: `Date | Workout | Exercise | Weight 1 | Set 1 | Weight 2 | Set 2 | Comment`
- Row 2: `3/2/2026 | MAPS Anabolic Phase 1 Day A | Barbell Squat | 185 | 8 | 185 | 8 |`
- Row 3: ` | | Barbell Bench Press | 155 | 8 | 155 | 7 | last set was hard`

## Connect it

- In **Settings**, then **Data feeds**, tap **Connect an existing sheet** and allow **read-only** access to your spreadsheets. Health Review can only read; it never changes or deletes anything.
- Google may show "Google hasn't verified this app" while the app's review with Google is pending. Choose **Advanced**, then **Go to Health Review**.
- Paste the link to your Workout Log sheet and tap **Save sheet**. Health Review checks it can open it and that it has a year tab.

## Syncing

- Your log is read every morning, and whenever you tap **Sync now** on Home. Only the current year's tab is read (and last year's in January).
- Exercise names are matched to a dictionary, so `Squats` and `Barbell Back Squat` count as the same lift.

## Disconnect

- **Disconnect** in Settings forgets the permission and your sheet. You can also remove access at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

[All guides](/guides)
