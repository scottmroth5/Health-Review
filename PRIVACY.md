# Privacy Policy

Health Review is a personal tool. It is run by the owner of this repository for their own weekly health review and is not offered as a service to anyone else.

## What it accesses

Signing in to the hosted app uses Google sign-in with only the `openid` and `email` permissions, to check that the person signing in is the operator. No one else's account is allowed in.

For its data, Health Review uses the operator's own Google account with these permissions:

- **Google Sheets, read only** (`spreadsheets.readonly`): reads the operator's own workout log spreadsheet, and health files exported in Sheets format. It cannot change or delete any spreadsheet.
- **Google Drive, read only** (`drive.readonly` and `drive.metadata.readonly`): lists and reads the Health Auto Export files in the folders the operator configures. It never changes or deletes them.
- **Google Drive, files it created** (`drive.file`): uploads the encrypted nightly backup to a backups folder. It can see only the files it created.

Health Auto Export on the operator's phone can also send health data straight to the hosted app over HTTPS, using a secret token.

## Where data is kept

- Data is kept in a database on machines the operator runs: their own computer, and a server in their own Amazon Web Services account.
- The server is reached only over HTTPS, and only after the operator signs in. A separate public demo shows made-up data and has no access to real data.
- The server's disk is encrypted by Amazon with keys Amazon manages. The operator accepts this for now; a later move will use encryption keys the operator controls.
- Any other copy kept off those machines (for example a backup in cloud storage) is encrypted before it leaves, with a key only the operator holds, and sent over HTTPS.

## How data is used

- Data is used only to produce the operator's own weekly health review.
- Health metrics are calculated by the app. Only computed summaries, and the operator's own notes for the week, are sent to the Anthropic Claude API to write the review. Raw exports are never sent.
- Data is not sold, shared with third parties, or used for advertising.
- Use of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including its Limited Use requirements.

## Revoking access

The operator can revoke Health Review's access at any time at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Contact

Questions about this policy can be raised as an issue on this repository.
