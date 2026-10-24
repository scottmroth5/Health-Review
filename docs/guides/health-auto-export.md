# Apple Health with Health Auto Export

Health Auto Export is an iPhone app that sends your Apple Health data to Health Review on a schedule. You need its premium plan for REST API automations.

## 1. Get your token

- In Health Review, open **Settings**, then **Data feeds**, and tap **Create token**.
- Copy the token right away: it is shown only once. If you lose it, tap **Replace token** and use the new one (the old one stops working).

## 2. Health metrics automation

In Health Auto Export, add an automation of type **REST API** with:

- **URL:** `{{SITE}}/api/ingest/health`
- **Headers:** Key `Authorization`, Value `Bearer ` followed by your token (the word Bearer, one space, then the token, no quotes).
- **Data:** Health Metrics. Turn on the metrics you want: steps, active energy, exercise minutes, stand time, heart rate variability, resting heart rate, sleep, VO2 max, walking heart rate, and any others.
- **Export format:** JSON, **Version 2**.
- **Summarize data:** on. **Time grouping:** Day.
- **Batch requests:** off.
- **Date range:** one that always covers yesterday and today in full (for example the last 2 or 7 days). Avoid "since last sync".
- **Schedule:** at least every few hours, including one run after midnight, so each day is marked complete.

## 3. Stand hours automation

The daily total of stand hours is undercounted, so add a second REST API automation:

- **URL:** `{{SITE}}/api/ingest/health` (the same one)
- **Headers:** the same Authorization header.
- **Data:** Health Metrics, only **Apple Stand Hour**.
- **Export format:** JSON, Version 2. **Summarize data:** on. **Time grouping:** Hours. **Batch requests:** off.

## 4. Workouts automation

- **URL:** `{{SITE}}/api/ingest/workouts`
- **Headers:** the same Authorization header.
- **Data:** Workouts, with **Include Workout Metrics** on (minute by minute heart rate, for the heart rate zones).
- **Export format:** JSON, Version 2. **Time grouping:** Minutes. **Batch requests:** off.
- **Date range:** the last few days, as above.

## 5. Check it works

- Run each automation by hand once. Health Review's **Settings** shows the time of your last post, and the **Activity** tab lists each post.
- Sending the same data again is harmless: nothing is counted twice.

## If a post fails

- **401:** the header is wrong. Check the key is exactly `Authorization` and the value is `Bearer ` and your token.
- **413:** too much data in one post. Use a shorter date range.
- **415:** the format isn't JSON.
- **429:** more than 30 posts in 15 minutes. Wait and try again.

[All guides](/guides)
