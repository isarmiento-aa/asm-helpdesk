// Admin "Import from Excel": reads the cleaned Google Form export in the browser, shows every
// ticket with any problems, and only writes when the admin clicks Import. Tickets keep their
// control number as their document id, so a ticket that is already in the system is skipped.
import {
  doc, getDoc, writeBatch, runTransaction, Timestamp,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";
import { db, $, esc, ticketLabel, excerpt } from "./common.js";
import { STATUSES, TICKET_PREFIX } from "./config.js";

const XLSX_URL = "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs";   // loaded only when a file is chosen
const PH_OFFSET_MS = 8 * 3_600_000;   // the sheet's times are Philippine time (UTC+8), as typed in the form

const COLS = {
  no: "Control No.", was: "Original Control No. (Google Form)", ts: "Timestamp", email: "Email Address",
  name: "Full Name", department: "Department", property: "Property", viber: "Viber Number",
  occurred: "Date/Time Issue Occurred", system: "Accounting System", module: "System Module Affected",
  category: "Issue Category", priority: "Priority Level", description: "Description of the Issue",
  notes: "Additional Notes", links: "Attachment Links", status: "Status", assignedTo: "Assigned To",
  escalatedTo: "Escalated To", resolution: "Resolution / Action Taken", resolved: "Date Resolved",
};
const REQUIRED_COLS = ["no", "ts", "email", "description", "status"];

let rows = [];

// Excel stores dates as day counts since 1899-12-30 with no time zone; read them as Philippine time.
function excelDate(v) {
  if (v === "" || v == null) return null;
  if (typeof v === "number") return v > 1 ? new Date(Math.round((v - 25569) * 86_400_000) - PH_OFFSET_MS) : null;
  const d = new Date(String(v).trim().replace(" ", "T") + "+08:00");
  return isNaN(d) ? undefined : d;   // undefined = present but unreadable
}

const str = (v) => (v == null ? "" : String(v).replace(/\r\n/g, "\n").trim());
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function toTicket(r, line) {
  const problems = [];
  const m = str(r[COLS.no]).match(new RegExp("^" + escapeRe(TICKET_PREFIX) + "(\\d+)$"));
  const ticketNo = m ? Number(m[1]) : null;
  if (!ticketNo) problems.push(`Control No. "${str(r[COLS.no])}" isn't like ${ticketLabel(1)}`);

  const created = excelDate(r[COLS.ts]);
  const occurred = excelDate(r[COLS.occurred]);
  const resolved = excelDate(r[COLS.resolved]);
  if (!created) problems.push("no readable Timestamp");
  if (occurred === undefined) problems.push("unreadable issue date");
  if (resolved === undefined) problems.push("unreadable Date Resolved");

  const email = str(r[COLS.email]).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) problems.push("missing or invalid email");
  const status = str(r[COLS.status]) || "New";
  if (!STATUSES.includes(status)) problems.push(`status "${status}" isn't one of ${STATUSES.join(", ")}`);
  const description = str(r[COLS.description]);
  if (!description) problems.push("no description");
  if (description.length > 5000 || str(r[COLS.notes]).length > 5000) problems.push("text longer than 5,000 characters");

  const links = str(r[COLS.links]).split(/[\n,]+/).map((s) => s.trim()).filter((s) => s.toLowerCase().startsWith("https://"));
  if (links.length > 10) problems.push("more than 10 attachment links");

  const ts = (d) => (d ? Timestamp.fromDate(d) : null);
  return {
    line, ticketNo, id: ticketNo ? ticketLabel(ticketNo) : null, problems,
    data: {
      source: "import",
      originalNo: str(r[COLS.was]),
      ticketNo,
      uid: "",
      email,
      name: str(r[COLS.name]),
      department: str(r[COLS.department]),
      property: str(r[COLS.property]),
      viber: str(r[COLS.viber]),
      occurredAt: ts(occurred || null),
      system: str(r[COLS.system]),
      module: str(r[COLS.module]),
      category: str(r[COLS.category]),
      priority: str(r[COLS.priority]),
      description,
      notes: str(r[COLS.notes]),
      attachments: [],
      links: links.slice(0, 10),
      status,
      assignedTo: str(r[COLS.assignedTo]),
      escalatedTo: str(r[COLS.escalatedTo]),
      resolution: str(r[COLS.resolution]),
      resolvedAt: ts(resolved || null),
      createdAt: ts(created || null),
      updatedAt: ts(resolved || created || null),
    },
  };
}

async function readFile(file, currentTickets) {
  const XLSX = await import(XLSX_URL);
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const ws = wb.Sheets.Tickets || wb.Sheets[wb.SheetNames[0]];
  const json = XLSX.utils.sheet_to_json(ws, { defval: "", raw: true });
  if (!json.length) throw new Error("the sheet has no rows");
  const missing = REQUIRED_COLS.map((k) => COLS[k]).filter((h) => !(h in json[0]));
  if (missing.length) throw new Error("missing column(s): " + missing.join(", ") + ". Is this the clean import file?");

  const list = json.map((r, i) => toTicket(r, i + 2));

  const seen = new Map();
  for (const t of list) {
    if (!t.ticketNo) continue;
    if (seen.has(t.ticketNo)) t.problems.push(`same Control No. as row ${seen.get(t.ticketNo)}`);
    else seen.set(t.ticketNo, t.line);
  }
  // Already imported (same document id) -> skip. Same number on a different ticket -> problem.
  await Promise.all(list.filter((t) => t.id).map(async (t) => {
    t.exists = (await getDoc(doc(db, "tickets", t.id))).exists();
    const clash = currentTickets().find((x) => x.ticketNo === t.ticketNo && x.id !== t.id);
    if (clash) t.problems.push(`${t.id} is already used by another ticket in the system`);
  }));
  return list;
}

function renderPreview() {
  const toImport = rows.filter((t) => !t.exists && !t.problems.length);
  const skipped = rows.filter((t) => t.exists && !t.problems.length);
  const bad = rows.filter((t) => t.problems.length);
  const sum = $("#import-summary");
  sum.className = "msg" + (bad.length ? " error" : "");
  sum.textContent = `${rows.length} rows: ${toImport.length} to import, ${skipped.length} already in the system (skipped)`
    + (bad.length ? `, ${bad.length} with problems. Fix them in the Excel file and choose it again.` : ".");

  $("#import-preview").innerHTML = rows.map((t) => `
    <tr class="${t.problems.length ? "imp-bad" : t.exists ? "imp-skip" : ""}">
      <td class="nowrap"><strong>${esc(t.id || "?")}</strong></td>
      <td class="nowrap muted">${esc(t.data.originalNo)}</td>
      <td class="nowrap">${t.data.createdAt ? t.data.createdAt.toDate().toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }) : "-"}</td>
      <td>${esc(t.data.name)}<br><span class="muted">${esc(t.data.property)}</span></td>
      <td>${esc(excerpt(t.data.description, 70))}${t.data.links.length ? ` <span class="badge">${t.data.links.length} link${t.data.links.length > 1 ? "s" : ""}</span>` : ""}</td>
      <td>${esc(t.data.status)}</td>
      <td>${t.problems.length ? `<span class="msg error">${t.problems.map(esc).join("; ")}</span>`
        : t.exists ? '<span class="muted">already in the system, skipped</span>' : '<span class="msg ok">ready</span>'}</td>
    </tr>`).join("");
  $("#import-preview-wrap").hidden = !rows.length;
  $("#import-go").disabled = !toImport.length || bad.length > 0;
  $("#import-go").textContent = toImport.length ? `Import ${toImport.length} ticket${toImport.length > 1 ? "s" : ""}` : "Import";
}

async function runImport() {
  const todo = rows.filter((t) => !t.exists && !t.problems.length);
  if (!todo.length) return;
  const msg = $("#import-msg");
  $("#import-go").disabled = true;
  $("#import-file").disabled = true;
  msg.className = "msg";
  try {
    // 1) Move the counter past the imported numbers FIRST, so a ticket submitted while the
    //    import runs can't take one of them.
    msg.textContent = "Updating the ticket counter...";
    const maxNo = Math.max(...rows.filter((t) => t.ticketNo).map((t) => t.ticketNo));
    const counterRef = doc(db, "counters", "tickets");
    const next = await runTransaction(db, async (tx) => {
      const snap = await tx.get(counterRef);
      const cur = snap.exists() ? snap.data().next : 1;
      const want = Math.max(cur, maxNo + 1);
      if (want !== cur) tx.set(counterRef, { next: want });
      return want;
    });

    // 2) The tickets, in batches.
    let done = 0;
    for (let i = 0; i < todo.length; i += 100) {
      const batch = writeBatch(db);
      for (const t of todo.slice(i, i + 100)) batch.set(doc(db, "tickets", t.id), t.data);
      await batch.commit();
      done += Math.min(100, todo.length - i);
      msg.textContent = `Imported ${done} of ${todo.length}...`;
    }
    todo.forEach((t) => { t.exists = true; });
    renderPreview();
    msg.className = "msg ok";
    msg.textContent = `Done: ${done} ticket${done > 1 ? "s" : ""} imported. The next new ticket will be ${ticketLabel(next)}.`;
  } catch (err) {
    msg.className = "msg error";
    msg.textContent = "Import stopped: " + err.message + ". Tickets saved before this point stay; choose the file again to finish the rest.";
  } finally {
    $("#import-file").disabled = false;
  }
}

export function setupImport(currentTickets) {
  $("#import-open").addEventListener("click", () => {
    $("#import").hidden = false;
    $("#import").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("#import-close").addEventListener("click", () => { $("#import").hidden = true; });

  $("#import-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    rows = [];
    renderPreview();
    $("#import-msg").textContent = "";
    if (!file) return;
    const sum = $("#import-summary");
    sum.className = "msg";
    sum.textContent = "Reading " + file.name + "...";
    try {
      rows = await readFile(file, currentTickets);
      renderPreview();
    } catch (err) {
      sum.className = "msg error";
      sum.textContent = "Couldn't read that file: " + err.message;
    }
  });

  $("#import-go").addEventListener("click", runImport);
}
