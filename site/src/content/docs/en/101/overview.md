---
title: What Is MailAgent
description: A macOS email assistant that puts AI inside your inbox—the moment a message lands it gets read, classified, prioritized, summarized, and drafted for reply. The important rises, the noise sinks, and every conclusion links back to the original.
---

## In one sentence

**MailAgent reads each email for you the instant it lands.** It automatically classifies every message, sets its priority, writes a one-line summary, and drafts a reply—so the important rises and the noise sinks, and every conclusion can be clicked back to the original email to verify.

It runs on your own Mac and keeps your email data on the machine. It is a "local-first" tool, not yet another cloud service that hauls your inbox onto someone else's servers.

:::tip[Is reading this one page enough?]
No, but it is the starting point. By the end of this page you will know what MailAgent can do for you and what you need to prepare. Then follow the left-hand table of contents from **[Install the Backend](/en/101/install-backend/)** step by step—in about half an hour you can go from zero to your first AI-processed email.
:::

## What it does for you

MailAgent has two parts: the **backend service** that quietly syncs and classifies email in the background, and the **desktop App** you open day to day to read mail, chat, and reply. Working together, they give you the capabilities below.

| Capability | What it means | Default |
|---|---|---|
| **Real-time email sync** | Sent/received mail, attachments, and the back-and-forth of a single topic (threads) are automatically mirrored into a Notion database as a searchable archive. | Always on |
| **AI auto-classification** | As soon as an email is stored, it is tagged with a category, a priority (Urgent / Important / Normal / Low), a one-line summary, and a suggested action, all written into the email itself. | Optional |
| **Full-text search** | The body plus attachment text (PDF / Word / PPT / Excel) all enter the full-text index; Chinese is searchable too, with matches highlighted. | Enabled with sync |
| **AI Chat panel** | Inside the desktop App, ask the AI about the current email, have it search across emails, and stream a drafted reply. | In the App |
| **One-click translation** | Translate English emails into Chinese with one click—available in the detail view, the toolbar, and in bulk. | In the App |
| **Meeting-invite detection** | Meeting invites (.ics) embedded in an email are automatically parsed into calendar events. | Always on |
| **Calendar sync** | Incrementally sync your Exchange calendar to the machine, viewed together with the meeting invites in your email. | Off (can enable) |
| **Dynamic Island notifications** (requires a separate plugin) | Important emails pop up as Dynamic Island cards, with one-click mark-as-read / flag / draft. | Off |
| **Feishu notifications** | Urgent / important emails are pushed to Feishu, with interactive reply buttons. | Off |
| **Remote web access** | While traveling, view your mail from an iPad / iPhone / someone else's computer through a browser. | Off |
| **Daily / weekly / monthly reports** | Each day the AI reviews the past 24 hours of email and curates it into a structured report you can actually finish reading. | Off |

> The capabilities marked "Off / Optional" above are not enabled by default; turn them on one by one as you need them—when you are just getting started, the first few rows alone are already plenty.

## Three things that set it apart

**1. Processed on arrival, not in after-the-fact batches.** Category, priority, summary, and suggested action are written the moment the email arrives. Open the list and you immediately see which one to read first, without scanning through everything again yourself.

**2. The AI writes the prose; the code guards the numbers.** The thing an email assistant fears most is "making things up." MailAgent's discipline: statistics, links, and email IDs are all deterministically backfilled by code; the AI is only responsible for wording and grouping. If the AI gets something wrong, only the phrasing is wrong, never the facts. Every number and every citation in a report can be clicked back to the real email to verify.

**3. Local-first, with transparent books.** Your email data lives on your Mac. Every AI call is accounted for—volume processed, spend, latency, cache hits, and sync health are all laid out on a dashboard, not decorative charts.

## System requirements

Before installing, confirm your environment meets these conditions.

| Item | Requirement |
|---|---|
| Operating system | macOS 12 (Monterey) or later; either Apple Silicon (M series) or Intel x64 works. |
| Mailbox | A corporate Exchange / Microsoft 365 mailbox (bridged via DavMail), or an account already added in the built-in macOS **Mail.app** (the AppleScript path). |
| Notion | A Notion workspace (the free plan is fine) to hold the synced email archive. The later [Initial Sync](/101/initial-sync/) section will walk you through building the required databases from scratch. |
| Runtime | Python 3.11+ (for installing the backend CLI). The desktop App ships with its own runtime—no separate Python install needed. |
| Network | The first launch requires internet access to verify the Notion API, and (if AI is enabled) to verify the LLM gateway. |
| AI (optional) | An Anthropic-compatible LLM gateway key, or a Notion Custom Agent. You can use sync and search without filling this in—you just won't have AI classification or Chat. |

:::caution[About the mailbox backend]
MailAgent supports two mailbox-access paths: **DavMail** (bridging corporate Exchange, fast, the currently recommended primary path) and **AppleScript** (driving macOS Mail.app directly, as an always-available fallback). You can switch between them with a single line of config. Note: the EWS protocol that DavMail currently relies on will be **shut down by Microsoft on 2026-10-01**; the migration plan is covered in later chapters and in the [migration roadmap](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/architecture/roadmap-post-cutover.md). The AppleScript path is unaffected.
:::

## A few words you'll see again and again

When you are getting started, the terms below will recur in the interface, the logs, and the docs. Just get a rough impression for now—no need to memorize them.

- **Backend / mail-sync**: the main sync service running in the background, responsible for moving email into the local database and then mirroring it to Notion.
- **Desktop App**: the graphical interface you open day to day—reading mail, searching, chatting, and replying all happen here.
- **SQLite**: the local database file on your Mac (`data/sync_store.db`), the "authoritative copy" of email bodies and attachments; Notion is its mirror.
- **DavMail**: a bridge program that translates a corporate Exchange mailbox into standard protocols, letting MailAgent read and write email at high speed.
- **Notion Integration / Token**: the "bot" you create in Notion; MailAgent uses its Token to write emails into your database.

A more complete glossary is in the [Troubleshooting FAQ](/101/troubleshooting/).

## Next up

- Not installed yet? Start from **[Install the Backend](/en/101/install-backend/)** and follow the full onboarding flow.
- Want to jump straight to daily use? Skip to **[Daily Workflow: Inbox](/101/daily-inbox/)**.
- Running into problems? Flip to the **[Troubleshooting FAQ](/101/troubleshooting/)**.

---

> Learn more about the full project and its architecture: [README](https://github.com/ChenyqThu/MailAgent/blob/main/README.md) · [Architecture Overview ARCHITECTURE.md](https://github.com/ChenyqThu/MailAgent/blob/main/ARCHITECTURE.md)
