// 1) Paste your Firebase web app config here:
//    Firebase console > Project settings > General > Your apps > SDK setup and configuration > Config
export const firebaseConfig = {
  apiKey: "AIzaSyAjcmlrQF__0Q2btba0PQ8QWKbVyZ-5yKg",
  authDomain: "accounting-system-helpdesk.firebaseapp.com",
  projectId: "accounting-system-helpdesk",
  storageBucket: "accounting-system-helpdesk.firebasestorage.app",
  messagingSenderId: "911938131479",
  appId: "1:911938131479:web:380917d3c39ab257852e52",
  measurementId: "G-2T9PBH815Y",
};

// 2) Only Google accounts on this domain can sign in.
//    If you change it, change it in firestore.rules too.
export const ALLOWED_DOMAIN = "asia-affinity.com";

// The ONLY admins, in two teams. Everyone else can just submit and follow their own tickets.
// To change a list, edit it here AND in firestore.rules (isFA / isBC), then publish the rules again.
//   Finance & Accounting: every ticket except Billing & Collection ones, plus B&C tickets B&C escalates.
//   Billing & Collection: tickets whose Department is BC_DEPARTMENT; they can escalate to F&A.
export const FA_ADMINS = ["cbasa@asia-affinity.com", "isarmiento@asia-affinity.com"];
export const BC_ADMINS = ["dtoraldo@asia-affinity.com", "cpapa@asia-affinity.com"];
export const BC_DEPARTMENT = "Billing & Collection";
export const TEAM_NAMES = { FA: "Finance & Accounting", BC: "Billing & Collection" };

// 3) Choices on the ticket form, taken from the Google Form's past answers.
//    Edit freely; they are stored as plain text.
export const CHOICES = {
  // Picks who handles the ticket: "Billing & Collection" goes to the B&C admins, the rest to F&A.
  // If you change these, change the department list in firestore.rules too.
  department: [
    "Billing & Collection",
    "Finance & Accounting",
  ],
  property: [
    "Bayshore Residential Resort 2",
    "One Uptown Residences",
    "Makati San Antonio Residences",
    "The Vion Tower",
    "Two Regis",
    "Uptown Arts",
    "18 Ave De Triomphe",
    "St. Moritz Private Estate",
    "La Cassia Residences",
    "Uptown Parksuites",
    "Gentry Manor",
    "Bryant Parklane",
    "Chelsea Parkplace",
    "St. Honore & St. Dominique",
    "Park McKinley West",
    "One Regis & One Manhattan",
    "The Pinnacle Condominium Association, Inc.",
    "Arcovia Palazzo – Altea and Benissa",
    "Sunny Coast Condominium Association, Inc.",
    "Maple Grove Commercial District Estate",
    "The Verdin at Maple Grove Condominium Association, Inc.",
    "Albany Luxury Residences Condominium Association, Inc.",
    "Lafayette Park Square Condominium Association, Inc.",
    "The Palladium Condominium Association, Inc.",
    "HQ Visayas",
    "HQ Luzon",
  ],
  system: [
    "IPAS",
    "Finance & Accounting",
    "Billing & Collection",
  ],
  // "Login & User Access" requests are not handled by the helpdesk yet, so it is not offered.
  module: [
    "Accounts Payable",
    "Accounts Receivable",
    "Billing",
    "Collections",
    "General Ledger",
    "Other",
  ],
  category: [
    "System Down / Unavailable",
    "System Error / Bug",
    "Data Discrepancy",
    "Access / Permission Issue",
    "Report / Output Issue",
    "Feature Request",
    "Other",
  ],
  // Most urgent first. The word before " - " is the short label shown in lists.
  priority: [
    "Critical - System Down / Blocking All Work",
    "High - Major Function Blocked",
    "Medium - Workaround Available",
    "Low - Minor Issue",
  ],
};

// Priorities that count as "urgent" on the dashboard (matched on the short label).
export const URGENT_PRIORITIES = ["Critical", "High"];

// Control numbers look like ASM-0001: the prefix, then the number padded to TICKET_DIGITS.
export const TICKET_PREFIX = "ASM-";
export const TICKET_DIGITS = 4;

// Attachments (PDF, PNG or JPG; stored inside Firestore). If you change these,
// change the same limits in firestore.rules. The free plan holds 1 GB in total, so keep them small.
export const MAX_FILES = 3;
export const MAX_FILE_MB = 5;

// Ticket statuses, as in the Google Form's "Status" column. "Resolved" counts as done;
// the others count as unresolved. If you change these, change the list in firestore.rules too.
export const STATUSES = ["New", "In Progress", "On Hold", "Resolved"];
export const DONE_STATUSES = ["Resolved"];
