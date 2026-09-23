---
title: Install the Desktop App
description: Download the .dmg for Apple Silicon on macOS or the .exe for x64 on Windows, what the system prompts on first launch mean, and how in-app auto-update works.
---

MailAgent is a single desktop App: email sync, AI classification, matters, contacts, the library, and chat are all built into one installer—no separate Python or CLI install needed. macOS and Windows install differently; pick the path for your system.

## macOS (Apple Silicon)

### Step 1: Download the .dmg

Go to [GitHub Releases](https://github.com/ChenyqThu/MailAgent/releases) and download the latest `MailAgent-x.y.z-arm64.dmg`.

:::note[Apple Silicon only, for now]
The current build only ships for Apple Silicon (M-series). An Intel Mac build is not available yet.
:::

### Step 2: Install into "Applications"

Double-click the downloaded `.dmg`, drag the `MailAgent` icon into the `Applications` folder, then eject the disk image.

### Step 3: First launch

MailAgent is signed with an Apple Developer ID and notarized. On first launch, macOS will typically just ask "this app was downloaded from the internet, are you sure you want to open it?"—click **Open**. No extra steps in System Settings are needed.

After that, launch it from Launchpad, Spotlight (`⌘ Space`, type "MailAgent"), or the Dock.

### Step 4: Walk through first-time setup

The first launch opens a setup wizard: checking system permissions, choosing a mailbox backend, connecting Notion (optional), the first sync, and turning on optional features. See **[In-App First-Time Setup](/en/101/onboarding/)** for the full walkthrough.

## Windows (x64)

### Step 1: Download the .exe

Go to [GitHub Releases](https://github.com/ChenyqThu/MailAgent/releases) and download the latest `MailAgent-x.y.z-win-x64.exe`.

### Step 2: Run the installer

Double-click the `.exe`, choose an install location, and finish the install. The Windows installer is not currently code-signed, so you may see a **Windows protected your PC** (SmartScreen) prompt on install or first run—click **More info**, then **Run anyway**.

### Step 3: Have Outlook ready (if using the native Outlook backend)

The recommended mailbox backend on Windows is the local **classic Outlook** (not the new "New Outlook," which has no automation interface). Before installing, make sure:

- Classic Outlook is installed and signed in;
- Outlook stays running while syncing;
- On first run, Outlook will show a "a program is trying to access" prompt—choose **Allow access** and pick the longest duration.

For a corporate Exchange / Microsoft 365 mailbox, you can also use DavMail instead—see [Connect Your Corporate Mailbox via DavMail](/en/101/davmail-setup/).

:::caution[No calendar on Windows yet]
The native Outlook backend does not sync the calendar. If you need calendar sync, use the DavMail backend instead.
:::

### Step 4: Walk through first-time setup

Same as macOS—see **[In-App First-Time Setup](/en/101/onboarding/)**.

## In-app auto-update

On both platforms, the App checks for updates about 10 seconds after launch, then periodically thereafter. When a new version is available, the App prompts you to download it in-app; once downloaded, one click restarts and finishes the install. If the database needs a structural upgrade, it happens automatically on launch—**and cannot be rolled back to an older version afterward**; see [Updates, Upgrades, and Uninstalling](/en/101/updates/) for details.

## Next up

- Walk through the wizard: **[In-App First-Time Setup](/en/101/onboarding/)**.
- Corporate mailbox via DavMail: **[Connect Your Corporate Mailbox via DavMail](/en/101/davmail-setup/)**.
- Can't install / crashes on open? See the **[Troubleshooting FAQ](/en/101/troubleshooting/)**.

---

> Learn more: [Packaging and Release](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/packaging/packaging-release.md)
