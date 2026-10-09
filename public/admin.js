// Support queue: dashboard + every ticket, live, with status / assignment / action-taken editing.
// Only the ADMINS in config.js (enforced again by firestore.rules) can open it.
import {
  collection, doc, query, orderBy, limit, onSnapshot, updateDoc, getDoc, setDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";
import {
  db, $, esc, ticketLabel, fmtDate, prioShort, prioClass, excerpt, statusClass,
  attachmentLinks, fileBadge, setupAuth, isAgent,
} from "./common.js";
import { CHOICES, STATUSES, DONE_STATUSES, URGENT_PRIORITIES } from "./config.js";

const ACTIVE = STATUSES.filter((s) => !DONE_STATUSES.includes(s));
const isUrgent = (t) => URGENT_PRIORITIES.includes(prioShort(t.priority));
const MAX_TICKETS = 500;   // the dashboard and list cover the newest 500 tickets

let me = null;
let tickets = [];
let openId = null;
let savedId = null;
let stop = null;
const remarks = {};        // ticketId -> internal remarks text, loaded when a ticket is opened

for (const s of STATUSES) $("#f-status").insertAdjacentHTML("beforeend", `<option>${esc(s)}</option>`);
for (const p of CHOICES.priority) $("#f-priority").insertAdjacentHTML("beforeend", `<option value="${esc(p)}">${esc(prioShort(p))}</option>`);
for (const p of CHOICES.property) $("#f-property").insertAdjacentHTML("beforeend", `<option>${esc(p)}</option>`);
for (const m of CHOICES.module) $("#f-module").insertAdjacentHTML("beforeend", `<option>${esc(m)}</option>`);

setupAuth(async (user) => {
  if (stop) { stop(); stop = null; }
  me = user;
  const admin = user && await isAgent(user);
  $("#admin").hidden = !admin;
  $("#denied").hidden = !!admin;
  $("#denied-text").textContent = user
    ? `${user.email} is not a helpdesk admin. Use "Submit ticket" to send a ticket.`
    : "Sign in with a helpdesk admin account to see the queue.";
  if (!admin) return;

  const q = query(collection(db, "tickets"), orderBy("createdAt", "desc"), limit(MAX_TICKETS));
  stop = onSnapshot(q, (snap) => {
    tickets = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  }, (err) => {
    $("#rows").innerHTML = `<tr><td colspan="8" class="msg error">${esc(err.message)}</td></tr>`;
  });
});

// "Today" moves at midnight even if nothing changes, so refresh the counts every minute.
setInterval(() => { if (tickets.length) renderDashboard(); }, 60_000);

// ---- Dates ------------------------------------------------------------------

// A ticket saved a moment ago has no server time yet; treat it as now.
const created = (t) => (t.createdAt?.toDate ? t.createdAt.toDate() : new Date());
const resolved = (t) => (t.resolvedAt?.toDate ? t.resolvedAt.toDate() : null);

function startOfDay(daysAgo = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d;
}

function ageText(date) {
  const hours = Math.floor((Date.now() - date) / 3_600_000);
  if (hours < 1) return "under an hour old";
  if (hours < 24) return `${hours} hour${hours > 1 ? "s" : ""} old`;
  const days = Math.floor(hours / 24);
  return `${days} day${days > 1 ? "s" : ""} old`;
}

const hoursToResolve = (t) => (resolved(t) ? ((resolved(t) - created(t)) / 3_600_000).toFixed(1) : null);

// ---- Dashboard --------------------------------------------------------------

// Each tile sets the list filters when clicked.
function tileDefs() {
  const today = startOfDay(0), yesterday = startOfDay(1), weekAgo = startOfDay(7);
  const active = tickets.filter((t) => ACTIVE.includes(t.status));
  const done = tickets.filter((t) => DONE_STATUSES.includes(t.status));
  const count = (s) => tickets.filter((t) => t.status === s).length;
  const doneWeek = done.filter((t) => resolved(t) && resolved(t) >= weekAgo);
  const avg = doneWeek.length
    ? (doneWeek.reduce((n, t) => n + Number(hoursToResolve(t)), 0) / doneWeek.length).toFixed(1) : null;

  return [
    { label: "Submitted today", value: tickets.filter((t) => created(t) >= today).length,
      note: `${tickets.filter((t) => created(t) >= yesterday && created(t) < today).length} yesterday`,
      filter: { date: "today", status: "" } },
    { label: "Unresolved", value: active.length, main: true,
      note: ACTIVE.join(", "), filter: { status: "active" } },
    { label: "New", value: count("New"), note: "not started yet", filter: { status: "New" } },
    { label: "In progress", value: count("In Progress"), note: "being worked on", filter: { status: "In Progress" } },
    { label: "On hold", value: count("On Hold"), note: "waiting on someone", filter: { status: "On Hold" } },
    { label: "Urgent unresolved", value: active.filter(isUrgent).length, alert: true,
      note: URGENT_PRIORITIES.join(" or ") + " priority", filter: { status: "active", priority: "urgent" } },
    { label: "Resolved", value: done.length,
      note: `${doneWeek.length} in the last 7 days` + (avg ? ` · avg ${avg} hrs` : ""), filter: { status: DONE_STATUSES[0] } },
  ];
}

let tiles = [];

function renderDashboard() {
  $("#dash-date").textContent = "As of " + new Date().toLocaleString("en-PH",
    { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

  tiles = tileDefs();
  $("#tiles").innerHTML = tiles.map((t, i) => `
    <button type="button" class="tile${t.main ? " tile-main" : ""}${t.alert && t.value ? " tile-alert" : ""}"
      data-tile="${i}" title="Show these tickets in the list below">
      <span class="tile-label">${esc(t.label)}</span>
      <span class="tile-value">${t.value.toLocaleString("en-PH")}</span>
      <span class="tile-note">${esc(t.note)}</span>
    </button>`).join("");

  const active = tickets.filter((t) => ACTIVE.includes(t.status));

  const oldest = active.reduce((a, t) => (!a || created(t) < created(a) ? t : a), null);
  $("#oldest").innerHTML = oldest
    ? `Oldest unresolved: <a href="#" data-open="${oldest.id}">${ticketLabel(oldest.ticketNo)}</a>
       · ${ageText(created(oldest))} · ${esc(excerpt(oldest.description, 70))}`
    : "No unresolved tickets.";

  // Priority is an ordered scale, so every level is listed, in order, zeros included.
  const byPriority = CHOICES.priority
    .map((p) => ({ value: p, label: prioShort(p), n: active.filter((t) => t.priority === p).length }));
  // Modules have no order: biggest first, empty ones left out.
  const byModule = CHOICES.module
    .map((m) => ({ value: m, label: m, n: active.filter((t) => t.module === m).length }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n);

  $("#by-priority").innerHTML = hbars(byPriority, "priority");
  $("#by-module").innerHTML = byModule.length ? hbars(byModule, "module") : `<p class="muted">No unresolved tickets.</p>`;
}

// Horizontal bars, one color, counts written beside each bar.
function hbars(rows, field) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return rows.map((r) => `
    <button type="button" class="hbar" data-field="${field}" data-value="${esc(r.value)}"
      title="${esc(r.value)}: ${r.n} unresolved ticket${r.n === 1 ? "" : "s"}. Click to list them.">
      <span class="hbar-name">${esc(r.label)}</span>
      <span class="hbar-track"><span class="hbar-fill" style="width:${r.n ? Math.max(2, (r.n / max) * 100) : 0}%"></span></span>
      <span class="hbar-n">${r.n}</span>
    </button>`).join("");
}

function applyFilter(f) {
  $("#f-status").value = f.status ?? "active";
  $("#f-priority").value = f.priority ?? "";
  $("#f-property").value = f.property ?? "";
  $("#f-module").value = f.module ?? "";
  $("#f-date").value = f.date ?? "";
  $("#f-search").value = "";
  renderList();
  $("#queue").scrollIntoView({ behavior: "smooth", block: "start" });
}

$("#tiles").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tile]");
  if (b) applyFilter(tiles[Number(b.dataset.tile)].filter);
});

for (const id of ["#by-priority", "#by-module"]) {
  $(id).addEventListener("click", (e) => {
    const b = e.target.closest(".hbar");
    if (b) applyFilter({ status: "active", [b.dataset.field]: b.dataset.value });
  });
}

$("#oldest").addEventListener("click", (e) => {
  const a = e.target.closest("[data-open]");
  if (!a) return;
  e.preventDefault();
  openTicket(a.dataset.open);
  applyFilter({ status: "active" });
});

// ---- Ticket list ------------------------------------------------------------

for (const id of ["#f-status", "#f-priority", "#f-property", "#f-module", "#f-date"]) $(id).addEventListener("change", renderList);
$("#f-search").addEventListener("input", renderList);
$("#f-clear").addEventListener("click", () => applyFilter({ status: "" }));

function filtered() {
  const st = $("#f-status").value, pr = $("#f-priority").value;
  const pp = $("#f-property").value, mo = $("#f-module").value, dt = $("#f-date").value;
  const since = dt === "today" ? startOfDay(0) : dt === "7d" ? startOfDay(7) : dt === "30d" ? startOfDay(30) : null;
  const text = $("#f-search").value.trim().toLowerCase();
  return tickets.filter((t) =>
    (st === "active" ? ACTIVE.includes(t.status) : !st || t.status === st) &&
    (pr === "urgent" ? isUrgent(t) : !pr || t.priority === pr) &&
    (!pp || t.property === pp) &&
    (!mo || t.module === mo) &&
    (!since || created(t) >= since) &&
    (!text || [ticketLabel(t.ticketNo), t.description, t.name, t.email, t.property, t.department, t.system, t.module]
      .join(" ").toLowerCase().includes(text)));
}

function render() {
  renderDashboard();
  renderList();
}

function renderList() {
  // The table redraws on every change to any ticket; keep what an admin has typed but not saved.
  const open = $("#rows form.edit");
  const draft = open && open.dataset.dirty && {
    id: open.dataset.id, status: open.status.value, assignedTo: open.assignedTo.value,
    escalatedTo: open.escalatedTo.value, resolution: open.resolution.value, remarks: open.remarks.value,
  };

  const list = filtered();
  $("#showing").textContent = `Showing ${list.length} of ${tickets.length} ticket${tickets.length === 1 ? "" : "s"}`
    + (tickets.length >= MAX_TICKETS ? ` (newest ${MAX_TICKETS})` : "");
  if (!list.length) {
    $("#rows").innerHTML = `<tr><td colspan="8" class="muted">No tickets match these filters.</td></tr>`;
    return;
  }
  $("#rows").innerHTML = list.map((t) => `
    <tr class="row${t.id === openId ? " is-open" : ""}" data-id="${t.id}">
      <td class="nowrap"><strong>${ticketLabel(t.ticketNo)}</strong></td>
      <td>${esc(excerpt(t.description))}${fileBadge(t)}</td>
      <td>${esc(t.name)}<br><span class="muted">${esc(t.property)}</span></td>
      <td>${esc(t.module)}</td>
      <td class="${prioClass(t.priority)}" title="${esc(t.priority)}">${esc(prioShort(t.priority))}</td>
      <td>
        <select class="quick-status ${statusClass(t.status)}" data-id="${t.id}" aria-label="Status of ${ticketLabel(t.ticketNo)}">
          ${statusOptions(t.status)}
        </select>
      </td>
      <td>${esc(t.assignedTo) || '<span class="muted">-</span>'}</td>
      <td class="nowrap">${fmtDate(t.createdAt)}</td>
    </tr>
    ${t.id === openId ? detail(t) : ""}
  `).join("");

  const form = $("#rows form.edit");
  if (!form) return;
  if (savedId === form.dataset.id) {
    savedId = null;
    form.querySelector(".msg").className = "msg ok";
    form.querySelector(".msg").textContent = "Saved.";
  } else if (draft && draft.id === form.dataset.id) {
    for (const k of ["status", "assignedTo", "escalatedTo", "resolution", "remarks"]) form[k].value = draft[k];
    form.dataset.dirty = "1";
  }
}

// Includes the ticket's current status even if it isn't in the list any more (e.g. an old test ticket).
const statusOptions = (current) => [...new Set([...STATUSES, current].filter(Boolean))]
  .map((s) => `<option${s === current ? " selected" : ""}>${esc(s)}</option>`).join("");

function detail(t) {
  const hrs = hoursToResolve(t);
  const rem = remarks[t.id];
  return `
  <tr class="detail"><td colspan="8"><div class="detail-box">
    <dl>
      <dt>Email</dt><dd>${esc(t.email)}</dd>
      <dt>Viber number</dt><dd>${esc(t.viber) || "-"}</dd>
      <dt>Department</dt><dd>${esc(t.department) || "-"}</dd>
      <dt>Property</dt><dd>${esc(t.property) || "-"}</dd>
      <dt>Accounting system</dt><dd>${esc(t.system) || "-"}</dd>
      <dt>Module affected</dt><dd>${esc(t.module) || "-"}</dd>
      <dt>Issue category</dt><dd>${esc(t.category) || "-"}</dd>
      <dt>Priority</dt><dd class="${prioClass(t.priority)}">${esc(t.priority) || "-"}</dd>
      <dt>Issue occurred</dt><dd>${fmtDate(t.occurredAt) || "-"}</dd>
      <dt>Description</dt><dd>${esc(t.description)}</dd>
      <dt>Additional notes</dt><dd>${esc(t.notes) || "-"}</dd>
      <dt>Attachments</dt><dd>${attachmentLinks(t.attachments)}</dd>
      <dt>Submitted</dt><dd>${fmtDate(t.createdAt)}</dd>
      <dt>Date resolved</dt><dd>${t.resolvedAt ? `${fmtDate(t.resolvedAt)} · ${hrs} hrs` : "-"}</dd>
      <dt>Last update</dt><dd>${fmtDate(t.updatedAt)}</dd>
    </dl>
    <form class="edit" data-id="${t.id}">
      <div class="grid">
        <div>
          <label>Status</label>
          <select name="status">${statusOptions(t.status)}</select>
        </div>
        <div>
          <label>Assigned to</label>
          <input name="assignedTo" maxlength="100" value="${esc(t.assignedTo)}">
        </div>
        <div>
          <label>Escalated to</label>
          <input name="escalatedTo" maxlength="100" value="${esc(t.escalatedTo)}" placeholder="e.g. DEV">
        </div>
        <div></div>
        <div class="full">
          <label>Resolution / action taken <span class="muted">(the submitter can see this)</span></label>
          <textarea name="resolution" maxlength="5000">${esc(t.resolution)}</textarea>
        </div>
        <div class="full">
          <label>Support remarks <span class="muted">(admins only, never shown to the submitter)</span></label>
          <textarea name="remarks" maxlength="5000" ${rem === undefined ? 'placeholder="Loading..."' : ""}>${esc(rem ?? "")}</textarea>
          <p class="hint muted">Don't store passwords here. Send new-account passwords to the person directly.</p>
        </div>
      </div>
      <div class="actions">
        <button type="submit">Save</button>
        <span class="msg"></span>
      </div>
    </form>
  </div></td></tr>`;
}

async function openTicket(id) {
  openId = id;
  if (id && remarks[id] === undefined) {
    try {
      const snap = await getDoc(doc(db, "remarks", id));
      remarks[id] = snap.exists() ? snap.data().text : "";
    } catch {
      remarks[id] = "";
    }
    // Fill the box in place unless the admin has already started typing in it.
    const form = $(`#rows form.edit[data-id="${id}"]`);
    if (form && !form.dataset.dirty) { form.remarks.value = remarks[id]; form.remarks.placeholder = ""; }
  }
}

$("#rows").addEventListener("click", (e) => {
  if (e.target.closest("select, a, form")) return;   // the status dropdown, attachment links and the edit form
  const row = e.target.closest("tr.row");
  if (!row) return;
  const id = openId === row.dataset.id ? null : row.dataset.id;
  openId = id;
  renderList();
  if (id) openTicket(id);
});

$("#rows").addEventListener("input", (e) => {
  const form = e.target.closest("form.edit");
  if (form) form.dataset.dirty = "1";
});

// The ticket fields an admin may change, plus the "Date resolved" stamp when the status
// moves into or out of Resolved.
function statusPatch(ticket, newStatus) {
  const wasDone = DONE_STATUSES.includes(ticket.status), isDone = DONE_STATUSES.includes(newStatus);
  if (isDone && !wasDone) return { status: newStatus, resolvedAt: serverTimestamp() };
  if (!isDone && wasDone) return { status: newStatus, resolvedAt: null };
  return { status: newStatus };
}

// Quick status change straight from the list.
$("#rows").addEventListener("change", async (e) => {
  const sel = e.target.closest("select.quick-status");
  if (!sel) return;
  const t = tickets.find((x) => x.id === sel.dataset.id);
  sel.disabled = true;
  try {
    await updateDoc(doc(db, "tickets", t.id), { ...statusPatch(t, sel.value), updatedAt: serverTimestamp() });
  } catch (err) {
    alert("Could not change the status: " + err.message);
    renderList();   // put the dropdown back to the saved status
  }
});

$("#rows").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const id = form.dataset.id;
  const t = tickets.find((x) => x.id === id);
  const msg = form.querySelector(".msg");
  form.querySelector("button").disabled = true;
  msg.className = "msg";
  msg.textContent = "Saving...";
  const remarkText = form.remarks.value.trim();
  try {
    await updateDoc(doc(db, "tickets", id), {
      ...statusPatch(t, form.status.value),
      assignedTo: form.assignedTo.value.trim(),
      escalatedTo: form.escalatedTo.value.trim(),
      resolution: form.resolution.value.trim(),
      updatedAt: serverTimestamp(),
    });
    if (remarkText !== (remarks[id] ?? "")) {
      await setDoc(doc(db, "remarks", id), { text: remarkText, updatedBy: me.email, updatedAt: serverTimestamp() });
      remarks[id] = remarkText;
    }
    // The live listener has usually redrawn the table already (Firestore shows local changes
    // at once), so `form` may be gone: confirm on whichever form is on screen now,
    // and on the next redraw too.
    savedId = id;
    const current = $(`#rows form.edit[data-id="${id}"]`);
    if (current) {
      delete current.dataset.dirty;
      current.remarks.value = remarks[id] ?? "";
      current.querySelector(".msg").className = "msg ok";
      current.querySelector(".msg").textContent = "Saved.";
    }
  } catch (err) {
    const current = $(`#rows form.edit[data-id="${id}"]`) || form;
    current.querySelector(".msg").className = "msg error";
    current.querySelector(".msg").textContent = "Could not save: " + err.message;
    current.querySelector("button").disabled = false;
  }
});
