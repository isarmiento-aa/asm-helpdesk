// Shared Firebase setup, sign-in and small helpers for both pages.
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import {
  getFirestore, collection, getDocs,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";
import { firebaseConfig, ALLOWED_DOMAIN, ADMINS, TICKET_PREFIX, TICKET_DIGITS } from "./config.js";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

export const $ = (sel) => document.querySelector(sel);

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export const ticketLabel = (n) => TICKET_PREFIX + String(n ?? 0).padStart(TICKET_DIGITS, "0");

export function fmtDate(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" });
}

export function fmtSize(bytes) {
  return bytes < 1024 * 1024 ? Math.max(1, Math.round(bytes / 1024)) + " KB"
    : (bytes / 1024 / 1024).toFixed(1) + " MB";
}

// "High - Major Function Blocked" -> "High" (lists show the short word; details show it all).
export const prioShort = (p) => String(p ?? "").split(" - ")[0];
export const prioClass = (p) => "prio-" + prioShort(p).toLowerCase().replace(/[^a-z]/g, "");

// The description is the ticket's headline in lists: its first line, shortened.
export function excerpt(text, max = 90) {
  const line = String(text ?? "").trim().split(/\r?\n/)[0].trim();
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

// Links for a ticket's attachments. Clicking one goes through loadFile (below),
// so the Firestore rules decide whether this user may open it.
export function attachmentLinks(list) {
  if (!list || !list.length) return "-";
  return list.map((a) =>
    `<a href="#" class="att" data-file="${esc(a.fileId)}" data-type="${esc(a.type || "application/pdf")}">${esc(a.name)}</a>`
    + ` <span class="muted">(${fmtSize(a.size)})</span>`,
  ).join("<br>");
}

export function fileBadge(t) {
  const n = t.attachments?.length || 0;
  return n ? ` <span class="badge" title="${n} attachment${n > 1 ? "s" : ""}">${n} file${n > 1 ? "s" : ""}</span>` : "";
}

// A file is stored as files/{fileId} (its details) plus files/{fileId}/chunks/0, 1, 2...
// (the bytes, under 1 MB each, because a Firestore document can't be larger than 1 MB).
async function loadFile(fileId, type) {
  const snap = await getDocs(collection(db, "files", fileId, "chunks"));
  const parts = snap.docs
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((d) => d.data().data.toUint8Array());
  return new Blob(parts, { type });
}

document.addEventListener("click", async (e) => {
  const a = e.target.closest("a.att");
  if (!a) return;
  e.preventDefault();
  e.stopPropagation();
  // Open the tab now, while we still have the click; pop-up blockers refuse it after an await.
  const win = window.open("", "_blank");
  if (win) win.document.write("<p style='font:15px sans-serif'>Loading attachment...</p>");
  try {
    const url = URL.createObjectURL(await loadFile(a.dataset.file, a.dataset.type));
    if (win) win.location.href = url; else location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60_000);   // free the memory once the tab has it
  } catch (err) {
    if (win) win.close();
    alert("Could not open the attachment: " + err.message);
  }
}, true);

export const statusClass = (s) => "status status-" + String(s).toLowerCase().replace(/\s+/g, "-");

export function isAllowed(user) {
  return !!user && user.emailVerified && user.email.toLowerCase().endsWith("@" + ALLOWED_DOMAIN);
}

// Only decides what the page shows; the security rules enforce the same list on the server.
export async function isAgent(user) {
  return !!user && ADMINS.includes(user.email.toLowerCase());
}

// Wires the header's sign-in / sign-out controls and calls onChange(user | null).
export function setupAuth(onChange) {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ hd: ALLOWED_DOMAIN, prompt: "select_account" });

  $("#signin").addEventListener("click", async () => {
    $("#auth-msg").textContent = "";
    try {
      await signInWithPopup(auth, provider);
    } catch (e) {
      $("#auth-msg").textContent = "Sign-in failed: " + e.message;
    }
  });
  $("#signout").addEventListener("click", () => signOut(auth));

  onAuthStateChanged(auth, async (user) => {
    if (user && !isAllowed(user)) {
      await signOut(auth);
      $("#auth-msg").textContent = `Please sign in with your @${ALLOWED_DOMAIN} account.`;
      return;
    }
    $("#who").textContent = user ? user.email : "";
    $("#signin").hidden = !!user;
    $("#signout").hidden = !user;
    onChange(user);
  });
}
