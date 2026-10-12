/**
 * ASM Helpdesk: "ticket received" emails.
 *
 * Runs inside the "Helpdesk Email Routing" Google Sheet (Extensions > Apps Script), every minute.
 * It reads new tickets from the helpdesk's Firestore database and emails each submitter, with CCs
 * taken from the sheet's Routing tab (by Department, then Property). Every email is written to the
 * Sent log tab. The emails go out from the Google account that owns this script.
 *
 * Setup (once): run setup(), allow the permissions. That creates the every-minute trigger and
 * starts AFTER the newest ticket already in the database, so old tickets are never emailed.
 * Useful extras: previewRouting() and sendTestEmail() (both only email/log for you).
 */

const CONFIG = {
  PROJECT_ID: 'accounting-system-helpdesk',     // Firebase project
  SITE_URL: 'https://asm-helpdesk.vercel.app',  // link in the email
  SENDER_NAME: 'ASM Helpdesk',
  TICKET_PREFIX: 'ASM-',
  TICKET_DIGITS: 4,
  ROUTING_TAB: 'Routing',
  LOG_TAB: 'Sent log',
  BATCH: 25,          // tickets per run at most
  TIME_ZONE: 'Asia/Manila',
};

const PROPS = PropertiesService.getScriptProperties();
const LAST_KEY = 'lastTicketNo';

// ---- Entry points -------------------------------------------------------------------------

/** Run once. Starts after the newest existing ticket and installs the every-minute trigger. */
function setup() {
  ensureLogTab_();
  const newest = newestTicketNo_();
  PROPS.setProperty(LAST_KEY, String(newest));
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'checkNewTickets')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('checkNewTickets').timeBased().everyMinutes(1).create();
  log_('setup', '', '', `Ready. Will email tickets after ${label_(newest)}; checking every minute.`);
}

/** The trigger: email every ticket newer than the last one emailed. */
function checkNewTickets() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;   // a previous run is still going
  try {
    const last = Number(PROPS.getProperty(LAST_KEY));
    if (!Number.isFinite(last)) throw new Error('Not set up yet: run setup() first.');
    const tickets = ticketsAfter_(last);
    if (!tickets.length) return;
    const routing = loadRouting_();
    for (const t of tickets) {
      const mail = buildEmail_(t, routing);
      if (!mail) {                                  // nothing to send (e.g. imported ticket)
        PROPS.setProperty(LAST_KEY, String(t.ticketNo));
        continue;
      }
      if (MailApp.getRemainingDailyQuota() < 1 + mail.cc.length) {
        log_(label_(t.ticketNo), mail.to, mail.cc.join(', '), 'WAITING: daily email quota used up; will retry.');
        return;
      }
      try {
        MailApp.sendEmail({ to: mail.to, cc: mail.cc.join(','), subject: mail.subject,
          htmlBody: mail.html, body: mail.text, name: CONFIG.SENDER_NAME });
        log_(label_(t.ticketNo), mail.to, mail.cc.join(', '), 'Sent: ' + mail.subject);
      } catch (err) {
        // Leave the counter where it is, so the next run tries this ticket again.
        log_(label_(t.ticketNo), mail.to, mail.cc.join(', '), 'ERROR: ' + err.message);
        return;
      }
      PROPS.setProperty(LAST_KEY, String(t.ticketNo));
    }
  } finally {
    lock.releaseLock();
  }
}

/** Logs who would be TO/CC for every department + property, without sending anything. */
function previewRouting() {
  const routing = loadRouting_();
  const props = [...new Set(routing.rows.map((r) => r.property).filter((p) => p !== '*'))];
  const out = [];
  for (const dept of routing.departments) {
    for (const p of props.concat(['(any other property)'])) {
      const cc = ccFor_(routing, dept, p, 'submitter@asia-affinity.com');
      out.push(`${dept} | ${p} -> CC: ${cc.join(', ') || '(none)'}`);
    }
  }
  console.log(out.join('\n'));
}

/** Sends the email for the newest ticket to YOU only (no CCs), to check the wording. */
function sendTestEmail() {
  const newest = newestTicketNo_();
  if (!newest) throw new Error('No tickets in the database yet.');
  const t = ticketsAfter_(newest - 1)[0];
  const mail = buildEmail_(t, loadRouting_());
  const me = Session.getActiveUser().getEmail();
  MailApp.sendEmail({ to: me, subject: '[TEST] ' + mail.subject, name: CONFIG.SENDER_NAME,
    htmlBody: `<p style="color:#b42318"><b>Test:</b> the real email would go TO ${mail.to}, CC ${mail.cc.join(', ') || '(none)'}.</p>` + mail.html,
    body: mail.text });
  log_(label_(t.ticketNo), me, '', 'TEST email sent to you only.');
}

// ---- Routing (the Routing tab) ------------------------------------------------------------

/**
 * Routing tab columns: Department | Property | CC (comma or new-line separated) | Notes.
 * A row whose Property is * applies to every property of that department that has no row of its own.
 */
function loadRouting_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CONFIG.ROUTING_TAB);
  if (!sh) throw new Error(`No "${CONFIG.ROUTING_TAB}" tab in this spreadsheet.`);
  const values = sh.getDataRange().getDisplayValues().slice(1);
  const rows = values
    .filter((r) => r[0] && r[1])
    .map((r) => ({
      department: norm_(r[0]),
      property: r[1].trim() === '*' ? '*' : norm_(r[1]),
      cc: String(r[2] || '').split(/[,;\n]+/).map((e) => e.trim().toLowerCase()).filter(Boolean),
    }));
  return { rows, departments: [...new Set(rows.map((r) => r.department))] };
}

function ccFor_(routing, department, property, submitter) {
  const d = norm_(department), p = norm_(property);
  const exact = routing.rows.find((r) => r.department === d && r.property === p);
  const fallback = routing.rows.find((r) => r.department === d && r.property === '*');
  const cc = (exact || fallback || { cc: [] }).cc;
  const me = String(submitter || '').toLowerCase();
  return [...new Set(cc)].filter((e) => e !== me);   // no duplicates; never CC the submitter
}

const norm_ = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

// ---- The email ----------------------------------------------------------------------------

function buildEmail_(t, routing) {
  if (t.source === 'import' || !t.email) return null;
  const no = label_(t.ticketNo);
  const first = String(t.description || '').trim().split(/\r?\n/)[0];
  const headline = first.length > 70 ? first.slice(0, 69) + '…' : first;
  const greeting = String(t.name || '').trim().split(/\s+/)[0] || 'there';
  const fmt = (d) => (d ? Utilities.formatDate(d, CONFIG.TIME_ZONE, 'MMM d, yyyy h:mm a') : '-');
  const rows = [
    ['Control No.', no],
    ['Department', t.department], ['Property', t.property],
    ['Accounting system', t.system], ['Module affected', t.module],
    ['Issue category', t.category], ['Priority', t.priority],
    ['Issue occurred', fmt(t.occurredAt)], ['Submitted', fmt(t.createdAt)],
    ['Status', t.status || 'New'],
  ];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#1c2230;max-width:640px">
      <p>Hi ${esc(greeting)},</p>
      <p>We received your support ticket. Here are the details:</p>
      <table style="border-collapse:collapse;font-size:14px">
        ${rows.map(([k, v]) => `<tr><td style="padding:3px 14px 3px 0;color:#5f6878">${esc(k)}</td><td style="padding:3px 0"><b>${esc(v || '-')}</b></td></tr>`).join('')}
      </table>
      <p style="margin:14px 0 4px;color:#5f6878">Description</p>
      <div style="white-space:pre-wrap;border-left:3px solid #d0b300;padding:6px 10px;background:#f5f6f8">${esc(t.description)}</div>
      ${t.notes ? `<p style="margin:14px 0 4px;color:#5f6878">Additional notes</p><div style="white-space:pre-wrap">${esc(t.notes)}</div>` : ''}
      <p style="margin-top:18px">You can follow the status of this ticket at
        <a href="${CONFIG.SITE_URL}">${CONFIG.SITE_URL}</a> (sign in, then see <b>My Tickets</b>).</p>
      <p style="color:#5f6878;font-size:12px">This is an automatic message from the ASM Helpdesk.</p>
    </div>`;
  const text = [`Hi ${greeting},`, '', 'We received your support ticket.', '',
    ...rows.map(([k, v]) => `${k}: ${v || '-'}`), '', 'Description:', t.description || '',
    ...(t.notes ? ['', 'Additional notes:', t.notes] : []), '',
    `Follow it at ${CONFIG.SITE_URL} (sign in, then My Tickets).`].join('\n');
  return {
    to: t.email,
    cc: ccFor_(routing, t.department, t.property, t.email),
    subject: `[${no}] Ticket received: ${headline}`,
    html, text,
  };
}

const label_ = (n) => CONFIG.TICKET_PREFIX + String(n).padStart(CONFIG.TICKET_DIGITS, '0');

// ---- Firestore (read-only, with the script owner's own access to the Firebase project) ------

function ticketsAfter_(lastNo) {
  const res = firestoreQuery_({
    from: [{ collectionId: 'tickets' }],
    where: { fieldFilter: { field: { fieldPath: 'ticketNo' }, op: 'GREATER_THAN', value: { integerValue: String(lastNo) } } },
    orderBy: [{ field: { fieldPath: 'ticketNo' }, direction: 'ASCENDING' }],
    limit: CONFIG.BATCH,
  });
  return res.filter((r) => r.document).map((r) => fromFields_(r.document.fields || {}));
}

function newestTicketNo_() {
  const res = firestoreQuery_({
    from: [{ collectionId: 'tickets' }],
    orderBy: [{ field: { fieldPath: 'ticketNo' }, direction: 'DESCENDING' }],
    limit: 1,
  });
  const doc = res.find((r) => r.document);
  return doc ? Number(fromFields_(doc.document.fields).ticketNo) || 0 : 0;
}

function firestoreQuery_(structuredQuery) {
  const url = `https://firestore.googleapis.com/v1/projects/${CONFIG.PROJECT_ID}/databases/(default)/documents:runQuery`;
  const resp = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({ structuredQuery }),
  });
  if (resp.getResponseCode() !== 200) {
    throw new Error(`Firestore said ${resp.getResponseCode()}: ${resp.getContentText().slice(0, 300)}`);
  }
  return JSON.parse(resp.getContentText());
}

// Firestore REST values -> plain JavaScript.
function fromValue_(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return new Date(v.timestampValue);
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue_);
  if ('mapValue' in v) return fromFields_(v.mapValue.fields || {});
  return null;
}
function fromFields_(fields) {
  const o = {};
  for (const k in fields) o[k] = fromValue_(fields[k]);
  return o;
}

// ---- Sent log tab -------------------------------------------------------------------------

function ensureLogTab_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(CONFIG.LOG_TAB);
  if (!sh) sh = ss.insertSheet(CONFIG.LOG_TAB);
  if (sh.getLastRow() === 0) {
    sh.appendRow(['When', 'Ticket', 'To', 'CC', 'Result']);
    sh.setFrozenRows(1);
  }
  return sh;
}

function log_(ticket, to, cc, result) {
  ensureLogTab_().appendRow([Utilities.formatDate(new Date(), CONFIG.TIME_ZONE, 'yyyy-MM-dd HH:mm:ss'), ticket, to, cc, result]);
}
