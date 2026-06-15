---
title: Install the Desktop App
description: Download the .dmg for your architecture from GitHub Releases, drag it into Applications, get past Gatekeeper on first launch, grant permissions, and set up the MailAgent desktop App.
---

The desktop App is the backend's graphical interface: the three-column inbox, the AI panel, full-text search, one-click translation, and reply composing all live here. It reads the local database the backend writes and performs write operations through the backend.

:::caution[Backend first, then install the App]
The desktop App cannot work independently of the backend—it reads the `data/sync_store.db` the backend maintains. If you haven't got the backend running yet, go back to **[Install the Backend](/en/101/install-backend/)** and **[Initial Sync](/101/initial-sync/)** first. When the backend isn't running, opening the App will report that it can't find the database.
:::

## Step 1: Download the .dmg for your architecture

Go to [GitHub Releases](https://github.com/ChenyqThu/MailAgent/releases), find the latest version, and download per your Mac's processor:

- **Apple Silicon** (M1 / M2 / M3 / M4 Mac): `MailAgent-x.y.z-arm64.dmg`
- **Intel Mac**: `MailAgent-x.y.z-x64.dmg`

Not sure which you have? Click the **Apple menu  → About This Mac** and look at "Chip / Processor": if it says `Apple M*` it's Apple Silicon (choose arm64); if it says `Intel Core`, choose x64.

## Step 2: Install into "Applications"

1. Double-click the downloaded `.dmg` file.
2. Drag the `MailAgent` icon into the `Applications` folder.
3. After dragging, you can eject (unmount) that .dmg disk image.

## Step 3: First launch, getting past Gatekeeper

MailAgent is currently **ad-hoc signed** (it does not have a paid Apple Developer ID), so the first time you open it, macOS's Gatekeeper will block it. This is expected behavior; just do the following:

1. Find `MailAgent` in "Applications," then **right-click → Open**.
2. In the dialog, click **Open / Open Anyway** again.

:::tip
Only the **first time** requires opening via right-click. Once trusted, you can launch it directly from Launchpad, Spotlight (`⌘ Space`, type "MailAgent"), or the Dock from then on. If right-click is also blocked, go to **System Settings → Privacy & Security**; near the bottom of the page an "Open Anyway" button for MailAgent will appear—click it.
:::

## Step 4: Grant permissions

On first launch, macOS will pop up several permission requests; click **Allow**:

- **Documents folder access**: by default the App reads the database from `~/Documents/MailAgent/data/`.
- **Automation permission**: used when performing operations such as mark-as-read / flag / create draft.

If you didn't grant a permission at the time and later need to add it, go to **System Settings → Privacy & Security → Automation** and check the `Mail` sub-item under `MailAgent`.

### Full Disk Access (optional but recommended)

The database is by default at `~/Documents/MailAgent/data/`, and the "Documents folder access" above is usually enough. But if you've changed the database path to a protected directory such as `~/Library/...`, you need to add Full Disk Access manually:

**System Settings → Privacy & Security → Full Disk Access → +**, and add `MailAgent.app`.

## What you'll see after launching

The first time you open the App, it guides you through the in-app first-time setup (appearance, inbox polling, AI backend, keys, etc.). This part is walked through in detail in the next section.

Once setup is complete, the main interface is the three-column inbox: folders and AI Agents on the left, the email list in the middle, and details plus the AI fields panel on the right.

:::note[Don't let the App and the backend CLI write at the same time]
When you're using the desktop App, make sure the backend's PM2 `mail-sync` process is **stopped** (`pm2 stop mail-sync`), to avoid conflicts from the App and the CLI writing to the database simultaneously. If you're using DavMail, keep the `davmail-poc` bridge process (it isn't bundled into the App).
:::

## Next up

- Configure the App: **[In-App First-Time Setup](/101/onboarding/)**.
- Get started: **[Daily Workflow: Inbox](/101/daily-inbox/)**.
- Can't install / crashes on open? See the **[Troubleshooting FAQ](/101/troubleshooting/)**.

---

> Learn more: [Frontend Install Guide INSTALL.md](https://github.com/ChenyqThu/MailAgent/blob/main/frontend/INSTALL.md) · [Packaging and Release](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/packaging/packaging-release.md)
