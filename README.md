# Accounting System Helpdesk

A simple support-ticket site on Firebase that replaces the "Accounting System Helpdesk — Support
Ticket" Google Form. Plain HTML and JavaScript, no build step, **free Spark plan** (no billing card).

| Page | Who | What |
|---|---|---|
| `index.html` | anyone with an `@asia-affinity.com` Google account | **Submit a ticket** (same questions as the Google Form; gets `ASH-00001`, `ASH-00002`, ...) with up to 3 PDF/PNG/JPG attachments, and see **My Tickets** with status and action taken |
| `admin.html` | **only** `cbasa@` and `isarmiento@asia-affinity.com` | dashboard + every ticket: filter, search, open attachments, set status / assigned to / escalated to / action taken, and internal support remarks |

Files:

```
public/config.js     <- Firebase keys, allowed domain, ADMINS, form choices (properties etc.), limits
public/index.html/js <- submit form + My Tickets
public/admin.html/js <- dashboard + support queue
public/common.js     <- Firebase setup, Google sign-in, helpers
public/style.css
firestore.rules      <- who can read/write what (the real security; also lists the admins)
firebase.json
.vscode/             <- F5 "Run Helpdesk" runs it on http://localhost:8080
```

## The form (from the Google Form)

Full Name, Email (automatic), Department, Property, Viber Number, Date/Time Issue Occurred,
Accounting System, System Module Affected, Issue Category, Priority Level, Description of the Issue,
Attachment / Screenshot, Additional Notes.

Admin fields (as in the responses sheet): Control No., Status (New / In Progress / On Hold / Resolved),
Assigned To, Escalated To, Resolution / Action Taken (the submitter sees this), Date Resolved and
Resolution Time (filled in automatically when the status becomes Resolved), Support Remarks
(admins only, stored separately in `remarks/{ticketId}` so the submitter can never read them).

## One-time setup

1. **Create the project** at https://console.firebase.google.com (Analytics off).
2. **Add a web app** (Project settings > General > Your apps > Web) and copy the config into `public/config.js`.
3. **Turn on Google sign-in:** Build > Authentication > Sign-in method > Google > Enable.
4. **Create the database:** Build > Firestore Database > Create database > Standard, production mode,
   `asia-southeast1`. Don't create a Realtime Database or Storage; neither is used.
5. **Publish the rules:** Firestore Database > **Rules** tab, paste all of `firestore.rules`, **Publish**.
   Publish again every time `firestore.rules` changes.
6. **Run it:** in VS Code press **F5** (Run Helpdesk), or deploy it for everyone:

   ```powershell
   cd "C:\Users\cbasa\Desktop\ASM Helpdesk"
   firebase login
   firebase deploy --only "firestore:rules,hosting"
   ```

   The deployed site is `https://accounting-system-helpdesk.web.app`.

## Live on GitHub Pages

Every push to `main` publishes `public/` to **https://isarmiento-aa.github.io/asm-helpdesk/**
(`.github/workflows/pages.yml`). One-time setup:

1. The repo must be **public** (or on a paid GitHub plan): Settings > General > Danger Zone >
   Change visibility.
2. Settings > **Pages** > Build and deployment > Source = **GitHub Actions**.
3. Firebase console > Authentication > **Settings** > **Authorized domains** > Add domain >
   `isarmiento-aa.github.io` (otherwise Google sign-in fails with `auth/unauthorized-domain`).
4. Re-run the workflow (Actions tab > Deploy to GitHub Pages > Run workflow) or push any change.

`firestore.rules` is **not** deployed by this; publish it in the Firebase console whenever it changes.

## Admins

The admins are listed in **two** places that must match:
`ADMINS` in `public/config.js` (what the page shows) and `isAgent()` in `firestore.rules`
(what the database allows). To add or remove one, change both and publish the rules again.
Everyone else who signs in can only submit tickets and see their own.

## Ticket numbers

`ASH-` followed by 5 digits, from the counter document `counters/tickets` (field `next` = the number the
next ticket gets). To continue after the Google Form's last number (ASH-00016), set `next` to `17`
in the console before the first real ticket.

## How attachments work

- Stored **inside Firestore**: `files/{id}` holds the name, type and size, and
  `files/{id}/chunks/0, 1, 2...` hold the file in pieces under 1 MB (a Firestore document can't be larger).
- PDF, PNG or JPG only (checked by the file's first bytes), at most **3 per ticket, 5 MB each**.
- Saved before the ticket; if the ticket can't be saved, they are deleted. Locked once the ticket exists.
- Only the submitter and the admins can open them.

**Free-plan limits** (Firestore > Usage): 1 GB stored in total (roughly 300–500 tickets with
attachments), 20,000 writes and 50,000 reads a day. Each time an admin opens the support queue it reads
up to 500 tickets.

## Changing things

- **Form choices** (property, accounting system, module, issue category, priority) and
  **department suggestions:** `CHOICES` / `SUGGEST` in `public/config.js`.
- **Statuses:** `STATUSES` in `public/config.js` **and** the two status lists in `firestore.rules`.
- **Attachment limits:** `MAX_FILES` / `MAX_FILE_MB` in `config.js` **and** `attachments.size() <= 3`,
  `fileSize <= 5 * 1024 * 1024`, `chunks <= 6` in `firestore.rules`.
- **New form fields:** the input in `index.html`, the `ticket` object in `index.js`, and the
  `hasOnly([...])` list plus a size check in `firestore.rules`.
