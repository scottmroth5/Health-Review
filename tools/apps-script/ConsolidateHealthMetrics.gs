// The owner's health consolidation script (Consolidated Apple Health Metrics spreadsheet, Extensions > Apps Script),
// patched so each day keeps ONE row: the fullest export of it. Drop-in replacement for the file that holds these
// functions. The constants (HEALTH_FOLDER_ID, HEALTH_MAIN_SHEET_NAME, HEALTH_ARCHIVE_SHEET_NAME, HEALTH_DATE_HEADER,
// HEALTH_DATE_COL_FALLBACK, HEALTH_ARCHIVE_AFTER_MONTHS, HEALTH_DELETE_AFTER_MONTHS) stay where they are in your
// project and are not redefined here. Archive, purge, locks and trigger setup work as before.
//
// What changed (marked "PATCH" below):
//  - The duplicate key was Date/Time plus the first metric (Active Energy). Health Auto Export re-exports a day while
//    it is still in progress, so a day whose Active Energy grew between runs got a second row, and the partial one
//    could win downstream. Now the key is the calendar day alone (healthDayKey_):
//      consolidation: a later export with MORE STEPS replaces that day's row in place; otherwise it is skipped. A day
//      already in the archive is skipped (it is complete).
//      archive: a day already in the archive keeps the fuller of the two rows.
//  - Consolidation collects new and replacement rows and writes them in batches instead of one appendRow per row.
//  - collapseHealthDuplicateDays() is an optional one-time cleanup of days that already have several rows.
// The Health Review app copes either way (it keeps the fullest row per day on import), so this is about a clean sheet.

// ===== HEALTH HELPERS =====
function getHealthMainSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(HEALTH_MAIN_SHEET_NAME);
  if (!sheet) {
    var names = ss.getSheets().map(function(s) { return s.getName(); }).join(", ");
    throw new Error("Main sheet not found: " + HEALTH_MAIN_SHEET_NAME + ". Tabs in this file: " + names);
  }
  return sheet;
}

function getHealthArchiveSheet_(header) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(HEALTH_ARCHIVE_SHEET_NAME) || ss.insertSheet(HEALTH_ARCHIVE_SHEET_NAME);
  if (sheet.getLastRow() === 0 && header) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
  }
  return sheet;
}

// Finds the date column by header text so a column order change does not break things
function healthDateCol_(header) {
  for (var c = 0; c < header.length; c++) {
    if (String(header[c]).trim().toLowerCase().indexOf(HEALTH_DATE_HEADER.toLowerCase()) === 0) return c;
  }
  return HEALTH_DATE_COL_FALLBACK;
}

function healthMonthsAgo_(n) {
  var d = new Date();
  d.setMonth(d.getMonth() - n);
  return d;
}

// Handles Date objects from Sheets and strings like "2026-09-14 00:00:00 -0400"
function parseHealthDate_(value) {
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (value === "" || value === null) return null;
  var s = String(value).trim();
  var d = new Date(s);
  if (!isNaN(d.getTime())) return d;
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  return null;
}

// Kept for anything else in your project that still calls it; this file no longer uses it.
function healthRowKey_(row) {
  return row[0] + "|" + row[1];
}

// PATCH: the calendar day of a row ('yyyy-MM-dd' in the spreadsheet's time zone), or null when unreadable.
function healthDayKey_(row, dateCol) {
  var d = parseHealthDate_(row[dateCol]);
  if (!d) return null;
  return Utilities.formatDate(d, SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), "yyyy-MM-dd");
}

// PATCH: the row's step count, or -1 when it has none (so any row with steps counts as fuller).
var HEALTH_STEPS_HEADER = "Step Count (steps)";
function healthStepsCol_(header) {
  for (var c = 0; c < header.length; c++) {
    if (String(header[c]).trim() === HEALTH_STEPS_HEADER) return c;
  }
  return -1;
}
function healthSteps_(row, stepsCol) {
  if (stepsCol < 0) return -1;
  var v = Number(row[stepsCol]);
  return row[stepsCol] === "" || isNaN(v) ? -1 : v;
}

function getHealthBody_(sheet, numCols) {
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, numCols).getValues();
}

function rewriteHealthBody_(sheet, rows, numCols) {
  var lastRow = sheet.getLastRow();
  var lastCol = Math.max(sheet.getLastColumn(), numCols);
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, lastCol).clearContent();
  if (rows.length > 0) {
    var normalized = rows.map(function(r) {
      var out = r.slice(0, numCols);
      while (out.length < numCols) out.push("");
      return out;
    });
    sheet.getRange(2, 1, normalized.length, numCols).setValues(normalized);
  }
  SpreadsheetApp.flush();
}

// PATCH: writes replacement rows in place and appends new rows in one batch, then empties both lists.
function flushHealthWrites_(sheet, numCols, appends, updates) {
  var fit = function(r) {
    var out = r.slice(0, numCols);
    while (out.length < numCols) out.push("");
    return out;
  };
  for (var rowNumber in updates) sheet.getRange(Number(rowNumber), 1, 1, numCols).setValues([fit(updates[rowNumber])]);
  if (appends.length) sheet.getRange(sheet.getLastRow() + 1, 1, appends.length, numCols).setValues(appends.map(fit));
  appends.length = 0;
  for (var k in updates) delete updates[k];
  SpreadsheetApp.flush();
}

// ===== CONSOLIDATION (patched) =====
// Changes from your version:
//  1. Writes to the named main sheet instead of getActiveSheet()
//  2. Dedupes against the archive tab too, so archived rows are not re-imported
//  3. Skips rows older than the delete cutoff, so purged rows do not come back
//  4. Script lock so it cannot overlap with archive or purge
//  5. PATCH: one row per day; a later export with more steps replaces the day's row; batched writes
function consolidateHealthMetrics() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log("Another run is in progress."); return; }

  try {
    var folder = DriveApp.getFolderById(HEALTH_FOLDER_ID);
    var destination = getHealthMainSheet_();
    var props = PropertiesService.getScriptProperties();
    var deleteCutoff = healthMonthsAgo_(HEALTH_DELETE_AFTER_MONTHS);

    var processedIndex = Number(props.getProperty("healthProcessedIndex") || 0);
    var headerWritten = props.getProperty("healthHeaderWritten") === "true";
    var startTime = new Date().getTime();
    var maxRunTime = 5 * 60 * 1000;

    if (processedIndex === 0) {
      var files = folder.getFiles();
      var fileList = [];
      while (files.hasNext()) {
        var f = files.next();
        if (f.getName().indexOf("Apple Health Metrics-HealthMetrics") !== -1) {
          fileList.push({ name: f.getName(), id: f.getId() });
        }
      }
      fileList.sort(function(a, b) { return a.name.localeCompare(b.name); });
      props.setProperty("healthFileList", JSON.stringify(fileList));
    }

    var fileList = JSON.parse(props.getProperty("healthFileList") || "[]");

    // PATCH: days already in main (row number and steps of the fullest row) and in the archive.
    var mainData = destination.getDataRange().getValues();
    var header = mainData.length ? mainData[0] : null;
    var mainDays = {};
    var archiveDays = {};
    if (header) {
      var mainDateCol = healthDateCol_(header);
      var mainStepsCol = healthStepsCol_(header);
      for (var r = 1; r < mainData.length; r++) {
        var key = healthDayKey_(mainData[r], mainDateCol);
        if (!key) continue;
        var steps = healthSteps_(mainData[r], mainStepsCol);
        if (!mainDays[key] || steps > mainDays[key].steps) mainDays[key] = { row: r + 1, steps: steps };
      }
    }
    var archive = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HEALTH_ARCHIVE_SHEET_NAME);
    if (archive && archive.getLastRow() > 1) {
      var archiveData = archive.getDataRange().getValues();
      var archiveDateCol = healthDateCol_(archiveData[0]);
      for (var a = 1; a < archiveData.length; a++) {
        var ak = healthDayKey_(archiveData[a], archiveDateCol);
        if (ak) archiveDays[ak] = true;
      }
    }

    var appends = [];     // new days, written together
    var appendIndex = {}; // day -> position in appends
    var updates = {};     // main row number -> fuller row
    var added = 0;
    var replaced = 0;

    for (var i = processedIndex; i < fileList.length; i++) {
      if (new Date().getTime() - startTime > maxRunTime) {
        if (header) flushHealthWrites_(destination, header.length, appends, updates);
        props.setProperty("healthProcessedIndex", i.toString());
        Logger.log("Paused at file " + i + " of " + fileList.length + ". Run again to continue.");
        return;
      }

      var ss = SpreadsheetApp.open(DriveApp.getFileById(fileList[i].id));
      var data = ss.getSheets()[0].getDataRange().getValues();
      if (data.length === 0) continue;

      if (!headerWritten) {
        if (destination.getLastRow() === 0) destination.appendRow(data[0]);
        headerWritten = true;
        props.setProperty("healthHeaderWritten", "true");
      }
      if (!header) header = destination.getRange(1, 1, 1, destination.getLastColumn()).getValues()[0];

      var dateCol = healthDateCol_(data[0]);
      var stepsCol = healthStepsCol_(data[0]);

      for (var j = 1; j < data.length; j++) {
        var row = data[j];
        var rowDate = parseHealthDate_(row[dateCol]);
        if (rowDate && rowDate < deleteCutoff) continue; // past retention, do not re-import
        var day = healthDayKey_(row, dateCol);
        if (!day || archiveDays[day]) continue;          // unreadable date, or already archived (complete)
        var s = healthSteps_(row, stepsCol);
        if (mainDays[day]) {
          if (s > mainDays[day].steps) {                 // a fuller export of a day already in main
            updates[mainDays[day].row] = row;
            mainDays[day].steps = s;
            replaced++;
          }
        } else if (appendIndex[day] !== undefined) {
          if (s > healthSteps_(appends[appendIndex[day]], stepsCol)) appends[appendIndex[day]] = row;
        } else {
          appendIndex[day] = appends.length;
          appends.push(row);
          added++;
        }
      }
    }
    if (header) flushHealthWrites_(destination, header.length, appends, updates);

    props.deleteProperty("healthProcessedIndex");
    props.deleteProperty("healthHeaderWritten");
    props.deleteProperty("healthFileList");
    Logger.log("All done! Processed " + fileList.length + " files: " + added + " new days, " + replaced + " days replaced by a fuller export.");
  } finally {
    lock.releaseLock();
  }
}

function resetHealthProgress() {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty("healthProcessedIndex");
  props.deleteProperty("healthHeaderWritten");
  props.deleteProperty("healthFileList");
  Logger.log("Health progress reset.");
}

// ===== ARCHIVE =====
// Moves rows 1 month or older from the main tab to the archive tab.
// PATCH: a day already in the archive keeps the fuller of the two rows (more steps) instead of a second row.
function archiveHealthData() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log("Another run is in progress."); return; }

  try {
    var main = getHealthMainSheet_();
    var mainData = main.getDataRange().getValues();
    if (mainData.length < 2) { Logger.log("Nothing to archive."); return; }

    var header = mainData[0];
    var numCols = header.length;
    var dateCol = healthDateCol_(header);
    var stepsCol = healthStepsCol_(header);
    var archiveCutoff = healthMonthsAgo_(HEALTH_ARCHIVE_AFTER_MONTHS);

    var keep = [], toArchive = [], unparsed = 0;
    for (var i = 1; i < mainData.length; i++) {
      var row = mainData[i];
      var d = parseHealthDate_(row[dateCol]);
      if (!d) { keep.push(row); unparsed++; continue; }
      if (d <= archiveCutoff) toArchive.push(row);
      else keep.push(row);
    }

    var note = unparsed
      ? " " + unparsed + " rows had unreadable dates in column " + (dateCol + 1) +
        " (" + header[dateCol] + ") and were left in main."
      : "";

    if (toArchive.length === 0) {
      Logger.log("Nothing old enough to archive." + note);
      return;
    }

    var archive = getHealthArchiveSheet_(header);
    var archiveRows = getHealthBody_(archive, numCols);
    var archiveIndex = {}; // day -> position in archiveRows
    archiveRows.forEach(function(r, n) {
      var k = healthDayKey_(r, dateCol);
      if (k && (archiveIndex[k] === undefined || healthSteps_(r, stepsCol) > healthSteps_(archiveRows[archiveIndex[k]], stepsCol))) archiveIndex[k] = n;
    });

    var archivedCount = 0;
    toArchive.forEach(function(row) {
      var key = healthDayKey_(row, dateCol);
      if (archiveIndex[key] === undefined) {
        archiveIndex[key] = archiveRows.length;
        archiveRows.push(row);
        archivedCount++;
      } else if (healthSteps_(row, stepsCol) > healthSteps_(archiveRows[archiveIndex[key]], stepsCol)) {
        archiveRows[archiveIndex[key]] = row; // the fuller copy of a day already archived
      }
    });

    archiveRows.sort(function(a, b) {
      var da = parseHealthDate_(a[dateCol]), db = parseHealthDate_(b[dateCol]);
      return (da ? da.getTime() : 0) - (db ? db.getTime() : 0);
    });

    // Write archive FIRST so a failure never loses rows removed from main
    rewriteHealthBody_(archive, archiveRows, numCols);
    rewriteHealthBody_(main, keep, numCols);

    Logger.log(
      "Archived " + archivedCount + " rows. Main now " + keep.length +
      " rows, archive " + archiveRows.length + " rows." + note
    );
  } finally {
    lock.releaseLock();
  }
}

// ===== PURGE =====
// Deletes rows 1 year or older from both the archive tab and the main tab.
function purgeHealthData() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log("Another run is in progress."); return; }

  try {
    var deleteCutoff = healthMonthsAgo_(HEALTH_DELETE_AFTER_MONTHS);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheets = [getHealthMainSheet_(), ss.getSheetByName(HEALTH_ARCHIVE_SHEET_NAME)];
    var summary = [];

    sheets.forEach(function(sheet) {
      if (!sheet || sheet.getLastRow() < 2) return;
      var numCols = sheet.getLastColumn();
      var header = sheet.getRange(1, 1, 1, numCols).getValues()[0];
      var dateCol = healthDateCol_(header);
      var rows = getHealthBody_(sheet, numCols);
      var kept = [], deleted = 0;

      rows.forEach(function(row) {
        var d = parseHealthDate_(row[dateCol]);
        if (d && d <= deleteCutoff) deleted++;
        else kept.push(row);
      });

      if (deleted > 0) rewriteHealthBody_(sheet, kept, numCols);
      summary.push(sheet.getName() + ": deleted " + deleted + ", kept " + kept.length);
    });

    Logger.log(summary.length ? summary.join(" | ") : "Nothing to purge.");
  } finally {
    lock.releaseLock();
  }
}

// ===== OPTIONAL ONE-TIME CLEANUP (PATCH) =====
// Keeps the fullest row (most steps) of each day in the main and archive tabs and removes the other copies.
// Run once by hand after a sheet backup (File > Make a copy). The Health Review app merges duplicates either way.
function collapseHealthDuplicateDays() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log("Another run is in progress."); return; }

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var summary = [];
    [getHealthMainSheet_(), ss.getSheetByName(HEALTH_ARCHIVE_SHEET_NAME)].forEach(function(sheet) {
      if (!sheet || sheet.getLastRow() < 2) return;
      var numCols = sheet.getLastColumn();
      var header = sheet.getRange(1, 1, 1, numCols).getValues()[0];
      var dateCol = healthDateCol_(header);
      var stepsCol = healthStepsCol_(header);
      var rows = getHealthBody_(sheet, numCols);
      var best = {}; // day -> position of its fullest row
      rows.forEach(function(row, n) {
        var k = healthDayKey_(row, dateCol);
        if (k && (best[k] === undefined || healthSteps_(row, stepsCol) > healthSteps_(rows[best[k]], stepsCol))) best[k] = n;
      });
      var kept = rows.filter(function(row, n) {
        var k = healthDayKey_(row, dateCol);
        return !k || best[k] === n;
      });
      if (kept.length < rows.length) rewriteHealthBody_(sheet, kept, numCols);
      summary.push(sheet.getName() + ": removed " + (rows.length - kept.length) + " duplicate rows, kept " + kept.length);
    });
    Logger.log(summary.join(" | "));
  } finally {
    lock.releaseLock();
  }
}

// ===== TRIGGER SETUP =====
// Run each once. Re-running replaces that trigger instead of stacking duplicates.
function setupHealthArchiveTrigger() {
  replaceHealthTrigger_("archiveHealthData", function(b) { return b.everyDays(1).atHour(3); });
  Logger.log("Daily health archive trigger installed (about 3 AM).");
}

function setupHealthPurgeTrigger() {
  replaceHealthTrigger_("purgeHealthData", function(b) { return b.onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(4); });
  Logger.log("Weekly health purge trigger installed (Sundays about 4 AM).");
}

function replaceHealthTrigger_(handler, schedule) {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === handler) ScriptApp.deleteTrigger(t);
  });
  schedule(ScriptApp.newTrigger(handler).timeBased()).create();
}
