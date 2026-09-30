// ============================================================
// CONFIGURATION
// All personal values and prompt text live in Script Properties:
// Project Settings (gear icon) > Script Properties.
//
// Required keys:
//   ANTHROPIC_API_KEY, EMAIL_RECIPIENT,
//   HEALTH_METRICS_SHEET_ID, WORKOUT_SESSIONS_SHEET_ID,
//   WORKOUT_LOG_SHEET_ID, DRINKING_LOG_SHEET_ID,
//   WEEKLY_CHECKIN_SHEET_ID
//   PROMPT_01_<name> ... PROMPT_NN_<name>  (assembled in numeric order)
//
// Prompt sections may contain {{TODAY}}, replaced with yyyy-MM-dd at run time.
// To add a prompt section, just add a new PROMPT_07_<name> property. No code change needed.
// ============================================================
var CONFIG_KEYS = {
  anthropicApiKey: 'ANTHROPIC_API_KEY',
  emailRecipient: 'EMAIL_RECIPIENT',
  healthMetricsSheetId: 'HEALTH_METRICS_SHEET_ID',
  workoutSessionsSheetId: 'WORKOUT_SESSIONS_SHEET_ID',
  workoutLogSheetId: 'WORKOUT_LOG_SHEET_ID',
  drinkingLogSheetId: 'DRINKING_LOG_SHEET_ID',
  weeklyCheckinSheetId: 'WEEKLY_CHECKIN_SHEET_ID'
};

var PROMPT_KEY_PATTERN = /^PROMPT_(\d+)_/;
var CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

function loadConfig() {
  var props = PropertiesService.getScriptProperties().getProperties();
  var config = {};
  var missing = [];

  Object.keys(CONFIG_KEYS).forEach(function(name) {
    var value = props[CONFIG_KEYS[name]];
    if (!value) missing.push(CONFIG_KEYS[name]);
    config[name] = value;
  });

  var promptKeys = Object.keys(props)
    .filter(function(key) { return PROMPT_KEY_PATTERN.test(key); })
    .sort(function(a, b) {
      return parseInt(a.match(PROMPT_KEY_PATTERN)[1], 10) - parseInt(b.match(PROMPT_KEY_PATTERN)[1], 10);
    });

  if (promptKeys.length === 0) missing.push('PROMPT_01_<name> (at least one prompt section)');
  if (missing.length > 0) throw new Error('Missing script properties: ' + missing.join(', '));

  config.promptSections = promptKeys.map(function(key) { return props[key]; });
  return config;
}

// ============================================================
// MAIN FUNCTION - This is what you schedule to run Sunday 8am
// ============================================================
function runWeeklyHealthReport() {
  var config = null;
  try {
    config = loadConfig();
    var today = new Date();

    var healthData = getSheetData(config.healthMetricsSheetId, 'Last7Days');
    var workoutSessionData = getSheetData(config.workoutSessionsSheetId, 'Last7Days');
    var workoutLogData = getSheetData(config.workoutLogSheetId, 'Last28Days');
    var drinkingData = getSheetData(config.drinkingLogSheetId, 'Last7Days');
    var checkinData = getSheetData(config.weeklyCheckinSheetId, 'Last7Days');

    var prompt = buildPrompt(config, today, healthData, workoutSessionData, workoutLogData, drinkingData, checkinData);

    var reportText = callClaudeAPI(config.anthropicApiKey, prompt);

    var emailHtml = formatEmailHtml(reportText, today);

    sendEmail(config.emailRecipient, emailHtml, today);

    Logger.log('Weekly health report sent successfully.');

  } catch (e) {
    Logger.log('Error running weekly health report: ' + e.toString());
    var recipient = (config && config.emailRecipient) ||
      PropertiesService.getScriptProperties().getProperty('EMAIL_RECIPIENT') ||
      Session.getEffectiveUser().getEmail();
    MailApp.sendEmail(recipient, 'Health Report Error', 'Error: ' + e.toString());
  }
}

// ============================================================
// PREVIEW - Run manually to verify the assembled prompt without calling the API
// ============================================================
function previewPrompt() {
  var config = loadConfig();
  var prompt = buildPrompt(config, new Date(),
    '[health data]', '[workout sessions]', '[workout log]', '[drinking log]', '[check-in]');
  Logger.log('Prompt sections loaded: ' + config.promptSections.length);
  Logger.log(prompt);
}

// ============================================================
// DATA FETCHING
// ============================================================
function getSheetData(sheetId, tabName) {
  try {
    var ss = SpreadsheetApp.openById(sheetId);
    var sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      Logger.log('Tab not found: ' + tabName + ' in sheet ' + sheetId);
      return 'No data';
    }
    var data = sheet.getDataRange().getValues();
    if (!data || data.length <= 1) return 'No data';

    // Format rows as readable text
    var headers = data[0];
    var rows = [];
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      if (row.every(function(cell) { return cell === '' || cell === null; })) continue;
      var rowParts = [];
      for (var j = 0; j < headers.length; j++) {
        if (headers[j] && row[j] !== '' && row[j] !== null) {
          var val = row[j];
          if (val instanceof Date) {
            val = Utilities.formatDate(val, Session.getScriptTimeZone(), 'M/d/yyyy');
          }
          rowParts.push(headers[j] + ': ' + val);
        }
      }
      if (rowParts.length > 0) rows.push(rowParts.join(' | '));
    }
    return rows.join('\n') || 'No data';
  } catch (e) {
    Logger.log('Error fetching ' + tabName + ': ' + e.toString());
    return 'Error fetching data';
  }
}

// ============================================================
// PROMPT BUILDER
// ============================================================
function buildPrompt(config, today, healthData, workoutSessionData, workoutLogData, drinkingData, checkinData) {
  var todayStr = Utilities.formatDate(today, Session.getScriptTimeZone(), 'yyyy-MM-dd');

  var instructions = config.promptSections
    .join('\n\n')
    .replace(/\{\{TODAY\}\}/g, todayStr);

  return instructions + '\n\n' +
    'APPLE WATCH DAILY METRICS (last 7 days):\n' + healthData + '\n\n' +
    'APPLE WATCH WORKOUT SESSIONS (last 7 days):\n' + workoutSessionData + '\n\n' +
    'MANUAL WORKOUT LOG (last 28 days):\n' + workoutLogData + '\n\n' +
    'DRINKING LOG (last 7 days):\n' + drinkingData + '\n\n' +
    'WEEKLY CHECK-IN:\n' + checkinData;
}

// ============================================================
// CLAUDE API CALL
// ============================================================
function callClaudeAPI(apiKey, prompt) {
  var url = 'https://api.anthropic.com/v1/messages';
  var payload = {
    model: CLAUDE_MODEL,
    max_tokens: 5000,
    messages: [{ role: 'user', content: prompt }]
  };

  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url, options);
  var data = JSON.parse(response.getContentText());

  if (data.error) throw new Error('Claude API error: ' + data.error.message);
  if (!data.content || !data.content[0]) throw new Error('Unexpected API response: ' + JSON.stringify(data));

  return data.content[0].text;
}

// ============================================================
// EMAIL FORMATTING
// ============================================================
function formatEmailHtml(rawText, today) {
  var todayStr = Utilities.formatDate(today, Session.getScriptTimeZone(), 'M/d/yyyy');

  // Clean up unicode
  var text = rawText
    .replace(/\u2014/g, '-').replace(/\u2013/g, '-')
    .replace(/\u2019/g, "'").replace(/\u2018/g, "'")
    .replace(/\u201c/g, '"').replace(/\u201d/g, '"')
    .replace(/\u2026/g, '...');

  // Convert markdown to HTML
  var html = text
    .replace(/^## (.+)$/gm, '<h2 style="color:#1a5276;font-family:Arial,sans-serif;font-size:18px;margin-top:28px;margin-bottom:8px;border-bottom:2px solid #1a5276;padding-bottom:6px;">$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^- (.+)$/gm, '<li style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;margin-bottom:6px;">$1</li>')
    .replace(/(<li[^>]*>[\s\S]*?<\/li>\n?)+/g, '<ul style="padding-left:20px;margin:8px 0;">$&</ul>')
    .replace(/\n\n/g, '</p><p style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;margin:10px 0;">')
    .replace(/\n/g, '<br>');

  return '<div style="max-width:620px;margin:0 auto;background:#ffffff;border-radius:6px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">' +
    '<div style="background:#1a5276;padding:24px 28px;">' +
      '<h1 style="color:#ffffff;font-family:Arial,sans-serif;margin:0;font-size:24px;font-weight:bold;">Weekly Health Report</h1>' +
      '<p style="color:#a9cce3;font-family:Arial,sans-serif;margin:6px 0 0;font-size:13px;">Week ending ' + todayStr + '</p>' +
    '</div>' +
    '<div style="padding:28px;background:#ffffff;">' +
      '<p style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;margin:0;">' + html + '</p>' +
    '</div>' +
    '<div style="padding:16px 28px;background:#f4f6f8;border-top:1px solid #e0e0e0;">' +
      '<p style="font-family:Arial,sans-serif;font-size:11px;color:#999999;margin:0;text-align:center;">' +
      'Generated by your personal health agent - Every Sunday at 8am - Powered by Claude AI' +
      '</p>' +
    '</div>' +
  '</div>';
}

// ============================================================
// EMAIL SENDER
// ============================================================
function sendEmail(recipient, htmlBody, today) {
  var todayStr = Utilities.formatDate(today, Session.getScriptTimeZone(), 'M/d/yyyy');
  MailApp.sendEmail({
    to: recipient,
    subject: 'Weekly Health Report - Week Ending ' + todayStr,
    htmlBody: htmlBody
  });
}