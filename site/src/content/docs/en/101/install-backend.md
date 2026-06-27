---
title: "(Developer) Run the Backend from Source"
description: Clone the repo, create a virtual environment, install the mailagent CLI, fill in the five required .env values, choose the DavMail or AppleScript backend, grant macOS permissions, and start the mail-sync service.
sidebar:
  badge:
    text: Advanced
    variant: caution
---

:::caution[Regular users don't need this page]
Just [install the desktop App](/en/101/install-app/)—the backend is already bundled inside, ready to go out of the box. This page is an advanced guide for **developers who want to run the backend from source** (contributing code, customizing, debugging).
:::

The backend is the engine of all of MailAgent: it syncs email in the background, runs AI classification, and maintains the local database. When running from source, the whole process is five steps and takes about 15 minutes if you follow along.

:::note
This page assumes you have read the system requirements in [What Is MailAgent](/en/101/overview/). You need: macOS 12+, Python 3.11+, and an Exchange / Mail.app mailbox. Notion is optional (see Step 2).
:::

## Step 1: Clone the repo and create a virtual environment

Open a terminal (Terminal or iTerm2) and run:

```bash
git clone https://github.com/ChenyqThu/MailAgent.git ~/Documents/MailAgent
cd ~/Documents/MailAgent
python3 -m venv venv
source venv/bin/activate
pip install -e ".[cli,dev]"
cp .env.example .env
```

The last line, `pip install -e ".[cli,dev]"`, installs the `mailagent` command into the virtual environment. The `-e` (editable install) flag makes code changes you pull via `git pull` take effect immediately, with no reinstall needed.

Verify the install:

```bash
which mailagent      # should point to venv/bin/mailagent
mailagent --version  # expected output 3.0.0
```

:::caution[Activate the venv every time you open a terminal]
The `mailagent` command is only available in a terminal where the virtual environment is activated. Each time you open a new terminal, first run `cd ~/Documents/MailAgent && source venv/bin/activate`. If `mailagent` is not found, nine times out of ten you forgot this step.
:::

## Step 2: Optional — build a Notion mirror

Notion is **optional**: MailAgent stores email bodies and attachments in a local SQLite database (the authoritative copy); Notion is only an optional extra archive mirror. Skip this step if you want a purely local SQLite setup—go straight to Step 3.

If you do want a Notion mirror, MailAgent needs two Notion databases: one for email, one for the calendar. **You must create these two databases in Notion first and set up their fields per the tables below**—the field names and types must match exactly, or sync will fail.

### 2a. Create the Integration and get the Token

1. Open [www.notion.so/my-integrations](https://www.notion.so/my-integrations) in your browser.
2. Click **New integration**, give it a name (e.g. `MailAgent`), and associate it with your workspace.
3. After creating it, copy the **Internal Integration Token** (starts with `ntn_`)—this is the `NOTION_TOKEN` in `.env`.

### 2b. Create the email database (13 fields)

Create a new Notion database (type `/database` on a page → Table - Full page) and add the fields per the table below. **Field names must correspond exactly:**

| Field name | Type | Description |
|---|---|---|
| `Subject` | Title | Email subject (just rename the built-in title column of the database) |
| `Message ID` | Text | Unique email identifier, used for deduplication |
| `Thread ID` | Text | Thread identifier, shared by emails on the same topic |
| `From` | Email | Sender address |
| `From Name` | Text | Sender display name |
| `To` | Text | Recipient |
| `CC` | Text | Carbon copy |
| `Date` | Date | Email date |
| `Parent Item` | Relation (pointing to this database itself) | Thread-head relation, stringing one topic together |
| `Mailbox` | Select | Inbox / Sent / Archive, etc. |
| `Is Read` | Checkbox | Whether read |
| `Is Flagged` | Checkbox | Whether flagged |
| `Has Attachments` | Checkbox | Whether it has attachments |
| `AI Action` | Select | AI-suggested action (Reply needed / For reference only / …) |
| `AI Priority` | Select | Options: `Critical` / `Urgent` / `Important` / `Normal` / `Low` |
| `AI Review Status` | Select | Options: `Pending` / `Reviewed` |

> `Parent Item` is a Relation that **points to itself**: when creating the field, choose this database itself as the data source. It lets replies on the same topic hang under the thread head.

Once it is set up, open the database's top-right **⋯ → Connections →** and add the `MailAgent` Integration you just created, otherwise it has no write permission. The 32-character hexadecimal segment in the database URL is the `EMAIL_DATABASE_ID`:

```
https://www.notion.so/<workspace>/<this segment is the DATABASE_ID>?v=...
```

### 2c. Create the calendar database (6 fields)

Likewise create a new database and set up:

| Field name | Type | Description |
|---|---|---|
| `Title` | Title | Event title |
| `Event ID` | Text | Unique event identifier, used for deduplication |
| `Time` | Date (with start/end) | Event start and end time |
| `URL` | URL | Teams / meeting link |
| `Location` | Text | Location |
| `Organizer` | Text | Organizer |

Remember to add the Integration connection here too; the ID in the URL is the `CALENDAR_DATABASE_ID`.

:::tip
Don't want to hand-craft the fields? You can create the Integration and the two empty databases first, then add the fields one by one—it's less hassle than editing a template. The field names' case and spacing must match the tables above exactly.
:::

## Step 3: Fill in the five required values in `.env`

Open `~/Documents/MailAgent/.env` in any editor and fill in at least these five values:

```bash
NOTION_TOKEN=ntn_xxxxxxxx          # the Integration Token from step 2a
EMAIL_DATABASE_ID=xxxxxxxx         # the ID of the email database from step 2b
CALENDAR_DATABASE_ID=xxxxxxxx      # the ID of the calendar database from step 2c
USER_EMAIL=your@company.com        # your email address
MAIL_ACCOUNT_NAME=Exchange         # the name of this account in Mail.app (used by the AppleScript backend)
```

Not sure what your account is named in Mail.app? Run:

```bash
mailagent debug mail-structure
```

It will list all accounts and mailboxes in Mail.app; put your account name into `MAIL_ACCOUNT_NAME`.

The full set of optional configuration (Feishu, Redis, AI gateway, individual feature toggles) is documented with comments in `.env.example`; use what you need.

## Step 4: Choose the mailbox backend

MailAgent switches between two mailbox-access paths with a single line of config:

```bash
MAILAGENT_BACKEND=applescript   # code default; corporate Exchange users should change to davmail
```

| Backend | How it connects to the mailbox | Who it's for | Speed |
|---|---|---|---|
| **davmail** (recommended) | Bridges corporate Exchange via DavMail (IMAP / SMTP / CalDAV) | Corporate Exchange / Microsoft 365 users who want it faster and more stable, with rich-text replies + multi-folder + direct calendar reads | ~236 ms per email |
| **applescript** | Drives the built-in macOS Mail.app directly | A zero-extra-component, ready-to-go fallback | ~1 second per email |

**Corporate Exchange / Microsoft 365 users should use DavMail**—faster and more stable, and it genuinely unlocks rich-text Reply All, multi-folder sync, and direct CalDAV calendar reads. The full steps for installation, authentication (including impersonating the Outlook client_id), confirming it runs, and daemonizing it are on the dedicated page **[Connect Your Corporate Mailbox via DavMail](/en/101/davmail-setup/)**.

Just want the fastest start, with your mailbox already signed in within Mail.app? Keep the `applescript` default—no extra components needed, and it's always available as a fallback.

## Step 5: Grant macOS permissions and start the service

### 5a. System permissions

The terminal App that runs MailAgent (Terminal / iTerm2) needs the permissions below. Open **System Settings → Privacy & Security** and grant each one:

| Permission | Location | Purpose |
|---|---|---|
| **Full Disk Access** | Privacy & Security → Full Disk Access | Read Mail.app's local database (the SQLite radar) |
| **Automation → Mail** | Privacy & Security → Automation | Operate Mail.app via AppleScript (mark read / flag / draft) |
| **Automation → System Events** | Privacy & Security → Automation | Simulate keystrokes to paste content when creating drafts |
| **Accessibility** | Privacy & Security → Accessibility | System Events sends keystrokes |
| **Screen Recording** | Privacy & Security → Screen Recording | Only needed when screenshotting a draft with `--screenshot` |

> If the system doesn't pop up a permission request automatically, run `mailagent debug mail-structure` once to trigger it, then go to the locations above and check the boxes. Note: a process started by PM2 inherits the permissions of the terminal it was started in; switching terminals requires re-authorization.

### 5b. Start mail-sync

For development / testing, run in the foreground:

```bash
python3 main.py
```

For production / long-running use, daemonize it in the background with PM2 (note that you must specify the Python interpreter inside the venv):

```bash
npm install -g pm2
pm2 start main.py --name mail-sync --interpreter ./venv/bin/python3
pm2 save && pm2 startup
```

Common PM2 commands:

```bash
pm2 status                # check whether the process is online
pm2 logs mail-sync        # tail the logs
pm2 restart mail-sync     # restart
```

### 5c. Confirm it's running

```bash
mailagent admin health -o json | jq .data.healthy   # expect true
tail -f logs/sync.log                                # there should be no ERROR lines in the logs
```

When you see the SQLite radar running every 5 seconds and `healthy` is `true`, the backend is installed.

## Next up

Once the backend is ready, the next step is to load your historical email: **[Initial Sync (CLI)](/en/101/initial-sync/)**. If you also want the graphical interface, go to **[Install the Desktop App](/en/101/install-app/)**.

---

> Learn more: [README Quick Start](https://github.com/ChenyqThu/MailAgent/blob/main/README.md) · [Full CLI Command Reference](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/cli/cli-reference.md) · [DavMail and the Architecture Core](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/architecture/architecture-internals.md)
