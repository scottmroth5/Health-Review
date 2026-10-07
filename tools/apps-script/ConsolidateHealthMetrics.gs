// Bound to the Consolidated Apple Health Metrics spreadsheet (Extensions > Apps Script). Keep the consolidated data
// tab as the FIRST tab. Paste this over the v1 script (see README.md, "Sheets pipeline"); the nightly trigger can keep
// calling consolidateHealthMetrics.
//
// Changes from v1 (legacy/ConsolidateHealthMetrics.gs):
//  - One row per day. v1 skipped a row only when Date/Time AND the first metric (Active Energy) matched, so a day
//    exported partly done and again later got a second row. Now the date alone is the key: an export whose copy of a
//    day has more steps replaces that day's row in place; otherwise it is skipped.
//  - Writes in batches (setValues) instead of one appendRow per row, so runs finish well inside the time limit.
//  - collapseDuplicateDays() is an optional one-time cleanup of days that already have several rows.
// The sheet's time zone is left as it is on purpose: the Health Review app corrects its effects (the 3-hour shift in
// workout Duration cells and the 03:00 date stamps), and changing it could move workout start times.

var FOLDER_ID = "xxx"; // Health Auto Export folder ID
var FILE_MATCH = "Apple Health Metrics-HealthMetrics";
var STEPS_HEADER = "Step Count (steps)";
var MAX_RUN_MS = 5 * 60 * 1000;

function consolidateHealthMetrics() {
  var destination = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var props = PropertiesService.getScriptProperties();
  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var startTime = new Date().getTime();
  var processedIndex = Number(props.getProperty("healthProcessedIndex") || 0);

  // Only build the file list on the first run of a batch.
  if (processedIndex === 0) {
    var files = DriveApp.getFolderById(FOLDER_ID).getFiles();
    var fileList = [];
    while (files.hasNext()) {
      var f = files.next();
      if (f.getName().indexOf(FILE_MATCH) !== -1) fileList.push({ name: f.getName(), id: f.getId() });
    }
    fileList.sort(function (a, b) { return a.name.localeCompare(b.name); });
    props.setProperty("healthFileList", JSON.stringify(fileList));
  }
  var fileList = JSON.parse(props.getProperty("healthFileList") || "[]");

  // What the sheet already holds: for each day, its row number and step count (the fullest row when there are several).
  var existing = destination.getDataRange().getValues();
  var header = existing.length ? existing[0] : null;
  var days = {};
  for (var r = 1; r < existing.length; r++) {
    var key = dayKey(existing[r][0], tz);
    if (!key) continue;
    var steps = stepsOf(existing[r], header);
    if (!days[key] || steps > days[key].steps) days[key] = { row: r + 1, steps: steps };
  }

  var appends = [];    // new days, written together at the end
  var appendIndex = {}; // day -> position in appends
  var updates = {};    // existing row number -> fuller values

  for (var i = processedIndex; i < fileList.length; i++) {
    if (new Date().getTime() - startTime > MAX_RUN_MS) {
      flush(destination, header, appends, updates);
      props.setProperty("healthProcessedIndex", String(i));
      Logger.log("Paused at file " + i + " of " + fileList.length + ". Run again to continue.");
      return;
    }
    var data = SpreadsheetApp.open(DriveApp.getFileById(fileList[i].id)).getSheets()[0].getDataRange().getValues();
    if (data.length === 0) continue;
    if (!header) {
      header = data[0];
      destination.getRange(1, 1, 1, header.length).setValues([header]);
    }
    for (var j = 1; j < data.length; j++) {
      var row = fit(data[j], header.length);
      var k = dayKey(row[0], tz);
      if (!k) continue;
      var s = stepsOf(row, header);
      if (days[k]) {
        if (s > days[k].steps) { updates[days[k].row] = row; days[k].steps = s; }
      } else if (appendIndex[k] !== undefined) {
        if (s > stepsOf(appends[appendIndex[k]], header)) appends[appendIndex[k]] = row;
      } else {
        appendIndex[k] = appends.length;
        appends.push(row);
      }
    }
  }
  flush(destination, header, appends, updates);

  props.deleteProperty("healthProcessedIndex");
  props.deleteProperty("healthFileList");
  Logger.log("All done. Processed " + fileList.length + " files: " + appends.length + " new days, "
    + Object.keys(updates).length + " days replaced by a fuller export.");
}

/** Optional, run once by hand: keeps the fullest row of each day and deletes the others. Back up the sheet first. */
function collapseDuplicateDays() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var values = sheet.getDataRange().getValues();
  var header = values[0];
  var best = {};
  for (var r = 1; r < values.length; r++) {
    var key = dayKey(values[r][0], tz);
    if (!key) continue;
    var steps = stepsOf(values[r], header);
    if (!best[key] || steps > best[key].steps) best[key] = { row: r + 1, steps: steps };
  }
  var remove = [];
  for (var r2 = 1; r2 < values.length; r2++) {
    var k2 = dayKey(values[r2][0], tz);
    if (k2 && best[k2].row !== r2 + 1) remove.push(r2 + 1);
  }
  for (var x = remove.length - 1; x >= 0; x--) sheet.deleteRow(remove[x]); // bottom up, so row numbers stay valid
  Logger.log("Removed " + remove.length + " duplicate rows.");
}

function resetHealthProgress() {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty("healthProcessedIndex");
  props.deleteProperty("healthFileList");
  props.deleteProperty("healthHeaderWritten"); // left over from v1
  Logger.log("Health progress reset.");
}

// ---- helpers ----

function flush(sheet, header, appends, updates) {
  for (var rowNumber in updates) {
    sheet.getRange(Number(rowNumber), 1, 1, header.length).setValues([updates[rowNumber]]);
  }
  if (appends.length) sheet.getRange(sheet.getLastRow() + 1, 1, appends.length, header.length).setValues(appends);
  appends.length = 0;
  for (var key in updates) delete updates[key];
}

/** 'yyyy-MM-dd' for a Date/Time cell (a Date, or export text that starts with the date); null for anything else. */
function dayKey(value, tz) {
  if (value instanceof Date) return Utilities.formatDate(value, tz, "yyyy-MM-dd");
  var m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || ""));
  return m ? m[1] : null;
}

function stepsOf(row, header) {
  var i = header ? header.indexOf(STEPS_HEADER) : -1;
  var v = i >= 0 ? Number(row[i]) : NaN;
  return isNaN(v) ? -1 : v;
}

/** The row padded or trimmed to the sheet's column count, so a batch write never fails on a ragged row. */
function fit(row, width) {
  var out = row.slice(0, width);
  while (out.length < width) out.push("");
  return out;
}
