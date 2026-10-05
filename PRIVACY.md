# Privacy Policy

Health Review is a personal tool. It is run by the owner of this repository for their own weekly health review and is not offered as a service to anyone else.

## What it accesses

When the operator signs in with their Google account, Health Review requests only this permission:

- **Google Sheets, read only** (`spreadsheets.readonly`): reads the operator's own health metrics, workout sessions, and workout log spreadsheets. It cannot change or delete any spreadsheet.

## How data is used

- Data is used only to produce the operator's own weekly health review.
- Spreadsheet data is copied into a local database on the operator's own computer.
- Any copy kept off that computer (for example a backup in cloud storage) is encrypted at rest and in transit, with keys only the operator holds.
- Health metrics are calculated locally. Only computed summaries are sent to the Anthropic Claude API to write the review. Raw spreadsheet rows are never sent.
- Data is not sold, shared with third parties, or used for advertising.
- Use of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including its Limited Use requirements.

## Revoking access

The operator can revoke Health Review's access at any time at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Contact

Questions about this policy can be raised as an issue on this repository.
