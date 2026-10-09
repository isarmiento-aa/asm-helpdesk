// Ticket submission page: the form (same questions as the old Google Form), plus a live list
// of the signed-in user's own tickets.
import {
  collection, doc, query, where, onSnapshot, runTransaction, serverTimestamp, writeBatch, Bytes, Timestamp,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";
import {
  db, $, esc, ticketLabel, fmtDate, fmtSize, prioShort, prioClass, excerpt, statusClass,
  attachmentLinks, fileBadge, setupAuth, isAgent,
} from "./common.js";
import { CHOICES, SUGGEST, MAX_FILES, MAX_FILE_MB } from "./config.js";

let currentUser = null;
let stopMyTickets = null;
let openTicketId = null;
let myTickets = [];
let pickedFiles = [];   // { file, type } picked for the ticket being written

// ---- Form setup ---------------------------------------------------------

for (const [field, options] of Object.entries(CHOICES)) {
  $("#" + field).innerHTML = `<option value="">- Select -</option>` +
    options.map((o) => `<option>${esc(o)}</option>`).join("");
}
for (const [field, options] of Object.entries(SUGGEST)) {
  $(`#${field}-list`).innerHTML = options.map((o) => `<option value="${esc(o)}">`).join("");
}

// The things a person types the same way every time are remembered on this computer only.
const REMEMBER = ["name", "department", "property", "viber"];
const remembered = () => { try { return JSON.parse(localStorage.getItem("helpdesk.me") || "{}"); } catch { return {}; } };
function remember() {
  try { localStorage.setItem("helpdesk.me", JSON.stringify(Object.fromEntries(REMEMBER.map((id) => [id, $("#" + id).value.trim()])))); } catch { /* private window */ }
}

const pad = (n) => String(n).padStart(2, "0");
const localInputValue = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

function fillDefaults() {
  const saved = remembered();
  $("#name").value = saved.name || currentUser?.displayName || "";
  $("#email").value = currentUser?.email || "";
  for (const id of ["department", "property", "viber"]) $("#" + id).value = saved[id] || "";
  if (!CHOICES.property.includes($("#property").value)) $("#property").value = "";
  const now = new Date();
  $("#occurredAt").value = localInputValue(now);
  $("#occurredAt").max = localInputValue(now);
}

setupAuth(async (user) => {
  currentUser = user;
  $("#signed-out").hidden = !!user;
  $("#signed-in").hidden = !user;
  if (stopMyTickets) { stopMyTickets(); stopMyTickets = null; }
  if (!user) return;

  fillDefaults();
  $("#agent-link").hidden = !(await isAgent(user));
  watchMyTickets(user.email);
});

// ---- Attachments (PDF, PNG, JPG) ------------------------------------------

$("#file-hint").textContent = `PDF, PNG or JPG. Up to ${MAX_FILES} files, ${MAX_FILE_MB} MB each.`;

// Decided by the file's first bytes, not its name, so a renamed file can't slip through.
async function fileType(file) {
  const b = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  if (String.fromCharCode(...b) === "%PDF-") return "application/pdf";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  return null;
}

$("#files").addEventListener("change", async (e) => {
  const problems = [];
  for (const file of e.target.files) {
    if (pickedFiles.length >= MAX_FILES) { problems.push(`only ${MAX_FILES} files allowed`); break; }
    const type = await fileType(file);
    if (!type) problems.push(`${file.name} is not a PDF, PNG or JPG`);
    else if (file.size > MAX_FILE_MB * 1024 * 1024) problems.push(`${file.name} is over ${MAX_FILE_MB} MB`);
    else if (pickedFiles.some((p) => p.file.name === file.name && p.file.size === file.size)) continue;
    else pickedFiles.push({ file, type });
  }
  e.target.value = "";   // so picking the same file again still fires "change"
  renderFileList();
  $("#form-msg").className = "msg error";
  $("#form-msg").textContent = problems.length ? "Skipped: " + problems.join("; ") : "";
});

function renderFileList() {
  $("#file-list").innerHTML = pickedFiles.map((p, i) => `
    <li><span class="name">${esc(p.file.name)}</span>
      <span class="muted">${fmtSize(p.file.size)}</span>
      <span class="progress muted" data-i="${i}"></span>
      <button type="button" class="secondary" data-remove="${i}">Remove</button></li>`).join("");
}

$("#file-list").addEventListener("click", (e) => {
  const i = e.target.dataset.remove;
  if (i === undefined) return;
  pickedFiles.splice(Number(i), 1);
  renderFileList();
  $("#form-msg").textContent = "";
});

// Files are kept in Firestore itself: files/{fileId} holds the details, and
// files/{fileId}/chunks/0, 1, 2... hold the bytes. A Firestore document can't exceed 1 MB,
// so each chunk carries at most CHUNK bytes. One batch per file: it is saved whole or not at all.
const CHUNK = 900 * 1024;

async function saveFiles(uid, ticketId) {
  const done = [];
  try {
    for (const [i, { file, type }] of pickedFiles.entries()) {
      const label = $(`#file-list .progress[data-i="${i}"]`);
      if (label) label.textContent = "saving...";
      const bytes = new Uint8Array(await file.arrayBuffer());
      const fileRef = doc(collection(db, "files"));
      const chunks = Math.ceil(bytes.length / CHUNK);
      const name = file.name.slice(0, 200);
      const batch = writeBatch(db);
      batch.set(fileRef, { uid, ticketId, name, type, fileSize: bytes.length, chunks, createdAt: serverTimestamp() });
      for (let c = 0; c < chunks; c++) {
        batch.set(doc(fileRef, "chunks", String(c)),
          { data: Bytes.fromUint8Array(bytes.subarray(c * CHUNK, (c + 1) * CHUNK)) });
      }
      await batch.commit();
      if (label) label.textContent = "saved";
      done.push({ fileId: fileRef.id, name, type, size: bytes.length, chunks });
    }
    return done;
  } catch (err) {
    await removeFiles(done);
    throw err;
  }
}

// Best-effort cleanup when the ticket itself could not be saved.
async function removeFiles(list) {
  await Promise.allSettled(list.map((a) => {
    const batch = writeBatch(db);
    for (let c = 0; c < a.chunks; c++) batch.delete(doc(db, "files", a.fileId, "chunks", String(c)));
    batch.delete(doc(db, "files", a.fileId));
    return batch.commit();
  }));
}

// ---- Submit -------------------------------------------------------------

$("#ticket-form").addEventListener("reset", () => {
  setTimeout(() => {
    fillDefaults();
    $("#form-msg").textContent = "";
    pickedFiles = [];
    renderFileList();
  });
});

const REQUIRED = ["name", "department", "property", "viber", "occurredAt", "system", "module", "category", "priority", "description"];

$("#ticket-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#form-msg");
  msg.className = "msg error";

  const v = (id) => $("#" + id).value.trim();
  const label = (id) => $(`label[for=${id}]`).firstChild.textContent.trim();
  const missing = REQUIRED.filter((id) => !v(id));
  if (missing.length) {
    msg.textContent = "Please fill in: " + missing.map(label).join(", ");
    $("#" + missing[0]).focus();
    return;
  }
  if (!/^[0-9+()\s-]{7,20}$/.test(v("viber")) || v("viber").replace(/\D/g, "").length < 7) {
    msg.textContent = "Please enter a valid Viber number, e.g. 09171234567.";
    $("#viber").focus();
    return;
  }
  const occurred = new Date(v("occurredAt"));
  if (isNaN(occurred) || occurred > new Date(Date.now() + 5 * 60_000)) {
    msg.textContent = "The date/time the issue occurred can't be in the future.";
    $("#occurredAt").focus();
    return;
  }

  const btn = $("#submit-btn");
  btn.disabled = true;
  msg.className = "msg";
  msg.textContent = "Submitting...";
  remember();

  const ticket = {
    uid: currentUser.uid,
    email: currentUser.email,
    name: v("name"),
    department: v("department"),
    property: v("property"),
    viber: v("viber"),
    occurredAt: Timestamp.fromDate(occurred),
    system: v("system"),
    module: v("module"),
    category: v("category"),
    priority: v("priority"),
    description: v("description"),
    notes: v("notes"),
    status: "New",
    assignedTo: "",
    escalatedTo: "",
    resolution: "",
    resolvedAt: null,
  };

  const counterRef = doc(db, "counters", "tickets");
  const ticketRef = doc(collection(db, "tickets"));
  let attachments = [];
  let step = "saving the attachments";
  try {
    if (pickedFiles.length) {
      msg.textContent = `Saving ${pickedFiles.length} attachment${pickedFiles.length > 1 ? "s" : ""}...`;
      attachments = await saveFiles(currentUser.uid, ticketRef.id);
      msg.textContent = "Submitting...";
    }
    ticket.attachments = attachments;
    step = "saving the ticket";

    // Ticket numbers come from one counter document, bumped in the same transaction
    // that creates the ticket, so two people submitting at once never get the same number.
    const ticketNo = await runTransaction(db, async (tx) => {
      const counter = await tx.get(counterRef);
      const next = counter.exists() ? counter.data().next : 1;
      tx.set(counterRef, { next: next + 1 });
      tx.set(ticketRef, { ...ticket, ticketNo: next, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      return next;
    });

    $("#ticket-form").reset();
    const ok = $("#success");
    ok.innerHTML = `Ticket submitted: <strong>${ticketLabel(ticketNo)}</strong><br>
      <span class="muted">${esc(excerpt(ticket.description))}. The support team will update its status below.</span>`;
    ok.hidden = false;
    ok.scrollIntoView({ behavior: "smooth" });
    msg.textContent = "";
  } catch (err) {
    await removeFiles(attachments);
    console.error("Ticket submit failed while " + step, err);
    msg.className = "msg error";
    msg.textContent = `Could not submit the ticket (failed while ${step}, signed in as ${currentUser.email}): ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

// ---- My tickets ---------------------------------------------------------

function watchMyTickets(email) {
  // Matched by email so tickets imported from the old Google Form (which have no account) show too.
  // Filtered only (no orderBy) so no composite index is needed; sorted here instead.
  const q = query(collection(db, "tickets"), where("email", "==", email));
  stopMyTickets = onSnapshot(q, (snap) => {
    myTickets = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.ticketNo || 0) - (a.ticketNo || 0));
    renderMyTickets();
  }, (err) => {
    $("#my-tickets").innerHTML = `<tr><td colspan="6" class="msg error">${esc(err.message)}</td></tr>`;
  });
}

function hoursBetween(a, b) {
  if (!a?.toDate || !b?.toDate) return "";
  return ((b.toDate() - a.toDate()) / 3_600_000).toFixed(1) + " hrs";
}

function renderMyTickets() {
  const body = $("#my-tickets");
  if (!myTickets.length) {
    body.innerHTML = `<tr><td colspan="6" class="muted">No tickets yet.</td></tr>`;
    return;
  }
  body.innerHTML = myTickets.map((t) => `
    <tr class="row" data-id="${t.id}">
      <td class="nowrap"><strong>${ticketLabel(t.ticketNo)}</strong></td>
      <td>${esc(excerpt(t.description))}${fileBadge(t)}</td>
      <td>${esc(t.module)}</td>
      <td class="${prioClass(t.priority)}" title="${esc(t.priority)}">${esc(prioShort(t.priority))}</td>
      <td><span class="${statusClass(t.status)}">${esc(t.status)}</span></td>
      <td class="nowrap">${fmtDate(t.createdAt)}</td>
    </tr>
    ${t.id === openTicketId ? `
    <tr class="detail"><td colspan="6"><div class="detail-box"><dl>
      <dt>Property</dt><dd>${esc(t.property) || "-"}</dd>
      <dt>Accounting system</dt><dd>${esc(t.system) || "-"}</dd>
      <dt>Issue category</dt><dd>${esc(t.category)}</dd>
      <dt>Priority</dt><dd>${esc(t.priority)}</dd>
      <dt>Issue occurred</dt><dd>${fmtDate(t.occurredAt) || "-"}</dd>
      <dt>Description</dt><dd>${esc(t.description)}</dd>
      <dt>Additional notes</dt><dd>${esc(t.notes) || "-"}</dd>
      <dt>Attachments</dt><dd>${attachmentLinks(t)}</dd>
      <dt>Assigned to</dt><dd>${esc(t.assignedTo) || "Not yet assigned"}</dd>
      <dt>Escalated to</dt><dd>${esc(t.escalatedTo) || "-"}</dd>
      <dt>Action taken</dt><dd>${esc(t.resolution) || "-"}</dd>
      <dt>Date resolved</dt><dd>${t.resolvedAt ? `${fmtDate(t.resolvedAt)} (${hoursBetween(t.createdAt, t.resolvedAt)})` : "-"}</dd>
      <dt>Last update</dt><dd>${fmtDate(t.updatedAt)}</dd>
    </dl></div></td></tr>` : ""}
  `).join("");
}

$("#my-tickets").addEventListener("click", (e) => {
  if (e.target.closest("a")) return;
  const row = e.target.closest("tr.row");
  if (!row) return;
  openTicketId = openTicketId === row.dataset.id ? null : row.dataset.id;
  renderMyTickets();
});
