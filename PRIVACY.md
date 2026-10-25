# Privacy Policy

Health Review is a personal project run by its owner (the operator), shared with a few people by invitation. It is not a commercial service.

## Signing in

- Signing in uses Google sign-in with only the `openid`, `email` and `profile` permissions: your address and first name, to know who you are. Nothing else in your Google account is read.
- Anyone can request access. The operator approves each request by hand.

## What is stored about you

- Your name, email address, when you joined, and your account status.
- The health and training data you choose to send: Apple Health data from Health Auto Export, check-ins, drinks, medications and supplements, lab results and workouts you enter or import.
- Your weekly reviews and chat messages, if you use the AI features.
- The training programs you add (built, imported, or read from a PDF you uploaded; the PDF itself is not kept), and your time zone.
- Your Claude API key, if you add one. It is stored encrypted, is never shown again after you enter it (not to you, and not on any screen the operator has), and is never written to logs.

## Who can see it

- **You** see only your own data. Every part of the app is limited to the signed-in user.
- **The operator** runs the server and can access the data stored on it, including yours. The app's administration screens show account details (name, email, status, whether a key is set), which feeds you set up (yes or no), when data last arrived, your AI spend this month and counts of your stored days and reviews; never your key, tokens or sheet links.
- **Nobody else.** Your data is not sold, shared with third parties or used for advertising.

## Your data feeds

- **Health Auto Export:** your iPhone sends your Apple Health data to Health Review over HTTPS with a token only you have (shown once; only a fingerprint of it is stored).
- **Google Sheets (only if you connect it):** read-only access to your spreadsheets (`spreadsheets.readonly`), used only to read the one Workout Log sheet you choose. If you choose **Create my Workout Log**, Health Review also asks for access to only the files it creates in your Drive (`drive.file`), and uses it once to create that sheet; it cannot see your other files. Health Review never changes or deletes anything. The permission is stored encrypted, and you can disconnect it in Settings or at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## AI (Anthropic's Claude)

- No AI is used for you until you add your own Claude API key in Settings, and then only for your own weekly review, Next program chat, Help's Ask and reading program PDFs you choose, billed to you by Anthropic.
- The operator may instead let you use the operator's own key up to a monthly limit, after telling you by email. Your use then shows on the operator's administration screen as a dollar amount, and when the limit is reached the AI stops until the next month. Your own key, if you add one, is always used instead.
- What is sent: computed summaries of your data (averages, changes, statuses, never raw exports) and your own notes for the week, under Anthropic's API terms.
- Help's Ask: only your question and the app's own guides are sent, never your data, and the answer is not kept.
- Program PDFs: only when you choose **Read a PDF with Claude** on the Programs screen and confirm you have the right to use the program. The file is sent once so Claude can read the program's structure, and Health Review does not keep it; only the program you check and save stays in your account.
- The server needs to use your key while you are away (the weekly review is scheduled), so the server can decrypt it; it does so only for your own requests.

## Where data is kept

- In a database on a server in the operator's own Amazon Web Services account, reached only over HTTPS and only after you sign in. A separate public demo holds made-up data only.
- The server's disk is encrypted by Amazon with keys Amazon manages. The operator accepts this for now; a later move will use encryption keys the operator controls.
- Backups are encrypted before they leave the server, with a key only the operator holds, and sent over HTTPS. Seven nightly, three weekly and one monthly backup are kept, so a backup ages out within about two months.

## The operator's own data

The operator's account also reads the operator's own Google Sheets and Drive files (Sheets and Drive read-only, and Drive access to files the app created for its encrypted backups). Use of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including its Limited Use requirements.

## Your choices

- **Export:** Settings, **Export my data** downloads everything stored for you as one file (never your encrypted key or tokens).
- **Pause:** Settings, **Pause my account** stops new data and AI until you resume; your data stays. The operator can pause your account too, and then only the operator can resume it.
- **Delete:** Settings, **Delete my account** removes your account and everything stored for you at once, after you type your email to confirm. Copies in the encrypted backups age out within about two months. You can also ask the operator to delete it.
- Remove your Claude key or disconnect Google Sheets at any time in Settings, and revoke the app's Google access at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Not medical advice

Nothing in Health Review is medical advice. See the [terms](/terms).

## Contact

Questions about this policy can be raised as an issue on this project's GitHub repository.
