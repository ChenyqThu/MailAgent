---
title: Privacy Policy
description: How MailAgent handles your email data, Notion authorization information, and local configuration—a local-first architecture's data-handling notes.
---

:::note[Scope]
This page describes how the officially distributed desktop App (with its bundled backend) and the accompanying Notion OAuth exchange proxy handle data. If you self-host the mail-sync backend from source, or use your own manually created Notion internal integration (bypassing one-click authorization), data handling is entirely under your own control—this page only describes the default behavior of the official distribution channel.
:::

## Local-first: email data is never uploaded to a developer-run server

MailAgent is a local-first desktop application. Email bodies, attachments, and AI classification results are stored in a local database (SQLite) on your own Mac, read and written directly by the App against the mail service you configure (Exchange / Microsoft 365 via DavMail, or macOS's built-in Mail.app). **There is no developer-operated server in this path**—your email content never passes through, nor is it ever stored on, any machine controlled by the MailAgent developer.

## Optional features you opt into

The features below are off by default, or require you to supply your own credentials before they take effect. Only once you enable them does data get sent to the corresponding third-party service—and in every case it's **your own account, your own data**:

| Feature | Where data goes | Who controls it |
|---|---|---|
| Notion mirror sync | Your own Notion workspace | Your Notion account |
| AI classification / AI Chat | The LLM gateway you configure (an Anthropic-compatible API, or a Notion Custom Agent) | Your own API key |
| Feishu notifications | A Feishu app you set up yourself | Your own Feishu credentials |
| Ping Island notifications | Local inter-process communication on the same Mac; never leaves the machine | This device |
| Runtime stats reporting | Only active if you explicitly set `STATS_REPORT_URL`; reports aggregated runtime status (e.g. sync counts, health heartbeats), never email bodies or attachments | Your choice, unconfigured by default |

## Notion OAuth authorization

"Connect Notion" is a one-click authorization entry point that replaces the manual steps of creating a Notion Integration and copying its Token. How it handles data:

- The authorization itself happens on Notion's own page—MailAgent never sees your Notion account credentials.
- Exchanging the authorization code for an Access Token goes through a **stateless proxy** deployed on a server operated by MailAgent—its sole purpose is to keep the integration secret (`client_secret`) out of the desktop App installer. This proxy **writes nothing to any database and never persists your Access Token**; its logs record only the request outcome, source IP, and timestamp, used for rate limiting and troubleshooting—the authorization code and the token itself never appear in logs.
- The Access Token you receive is stored only in your own Mac's local configuration file, the exact same way as a Token obtained by manually creating an Integration.
- MailAgent does not proactively refresh or extend this authorization—if you revoke MailAgent's access on the Notion side, sync will fail on its next call and the App will prompt you to reconnect.

## Your control

- **Revoke anytime**: go to Notion's **Settings → Connections** to revoke MailAgent's integration access at any time.
- **Remove the local configuration anytime**: the App's settings page offers "Remove connection from this device", which clears the locally stored Token, database IDs, and workspace information (this does not revoke access on the Notion side for you—do that via the previous step).
- **Turn off any feature anytime**: AI classification, Notion mirroring, Feishu notifications, etc. can each be disabled individually from the settings page; the corresponding data flow stops immediately.
- **Uninstalling clears everything**: uninstalling the App removes the locally stored email database and configuration. This data never left your device in the first place, so there's no scenario where you'd need to contact the developer to "delete cloud data."

## Changes

This page is updated as features evolve; material changes will be noted in release notes.

## Contact

MailAgent is an open-source personal project. Questions or feedback are welcome via [GitHub Issues](https://github.com/ChenyqThu/MailAgent/issues).
