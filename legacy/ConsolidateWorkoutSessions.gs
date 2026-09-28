// Bound to the Consolidated Apple Workout Sessions spreadsheet
// (Extensions > Apps Script). Keep the consolidated data tab as the FIRST tab.
function consolidateWorkoutFiles() {
  var folder = DriveApp.getFolderById("xxx"); // Health Auto Export folder ID
  var destination = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var props = PropertiesService.getScriptProperties();

  // Use distinct key from health metrics script
  var processedIndex = Number(props.getProperty("workoutProcessedIndex") || 0);
  var headerWritten = props.getProperty("workoutHeaderWritten") === "true";
  var startTime = new Date().getTime();
  var maxRunTime = 5 * 60 * 1000;

  // Only build file list on first run
  if (processedIndex === 0) {
    var files = folder.getFiles();
    var fileList = [];
    while (files.hasNext()) {
      var f = files.next();
      if (f.getName().indexOf("Workout session metrics") !== -1) {
        fileList.push({ name: f.getName(), id: f.getId() });
      }
    }
    // Sort chronologically by filename
    fileList.sort(function(a, b) {
      return a.name > b.name ? 1 : -1;
    });
    props.setProperty("workoutFileList", JSON.stringify(fileList));
  }

  var fileList = JSON.parse(props.getProperty("workoutFileList") || "[]");

  // Build a set of existing rows to prevent duplicates (Type + Start + End)
  var existingData = destination.getDataRange().getValues();
  var existingKeys = {};
  for (var r = 1; r < existingData.length; r++) {
    var key = existingData[r][0] + "|" + existingData[r][1] + "|" + existingData[r][2];
    existingKeys[key] = true;
  }

  for (var i = processedIndex; i < fileList.length; i++) {
    if (new Date().getTime() - startTime > maxRunTime) {
      props.setProperty("workoutProcessedIndex", i.toString());
      Logger.log("Paused at file " + i + " of " + fileList.length + ". Run again to continue.");
      return;
    }

    var file = DriveApp.getFileById(fileList[i].id);
    var ss = SpreadsheetApp.open(file);
    var sheet = ss.getSheets()[0];
    var data = sheet.getDataRange().getValues();

    if (data.length === 0) continue;

    if (!headerWritten) {
      var existingRows = destination.getLastRow();
      if (existingRows === 0) {
        destination.appendRow(data[0]);
      }
      headerWritten = true;
      props.setProperty("workoutHeaderWritten", "true");
    }

    for (var j = 1; j < data.length; j++) {
      var row = data[j];
      var key = row[0] + "|" + row[1] + "|" + row[2];
      if (!existingKeys[key]) {
        destination.appendRow(row);
        existingKeys[key] = true;
      }
    }
  }

  // Clean up all properties on completion
  props.deleteProperty("workoutProcessedIndex");
  props.deleteProperty("workoutHeaderWritten");
  props.deleteProperty("workoutFileList");
  Logger.log("All done! Processed " + fileList.length + " files.");
}

function resetWorkoutProgress() {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty("workoutProcessedIndex");
  props.deleteProperty("workoutHeaderWritten");
  props.deleteProperty("workoutFileList");
  Logger.log("Workout progress reset.");
}
