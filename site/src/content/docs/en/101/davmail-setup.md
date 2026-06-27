---
title: Connect Your Corporate Mailbox via DavMail (Recommended)
description: What DavMail is, why we recommend it as the mailbox source, how to install and authenticate it (including the OAuth flow that impersonates the Outlook desktop client_id and the redirect workaround), how to confirm the service is running, and how to daemonize it with PM2.
---

If your mailbox is **corporate Exchange / Microsoft 365**, we recommend using **DavMail** as MailAgent's mailbox source instead of the default AppleScript backend. It is faster, more stable, and actually unlocks rich-text Reply All, thread folding, multi-folder sync, and direct calendar reads.

This page covers DavMail from scratch: what it is, why, how to install it, how to authenticate, how to confirm it, and how to daemonize it.

:::note[An extra step for corporate Exchange users]
After installing the [desktop App](/en/101/install-app/), if your mailbox is corporate Exchange / Microsoft 365, you need to run DavMail separately as a mail source. This page explains how to install, authenticate, and daemonize it. The backend embedded in the App automatically detects and connects to a locally running DavMail. If you use a regular Mail.app mailbox, skip this page and go straight to [In-App First-Time Setup](/en/101/onboarding/).
:::

## What is DavMail

DavMail is an open-source **email protocol gateway** (a Java program). It translates Microsoft Exchange's proprietary protocols (EWS / Graph) into standard **IMAP / SMTP / CalDAV / LDAP**, exposing a set of local ports on your machine:

```
Mail.app / Outlook proprietary path   DavMail path
─────────────────────────────────    ───────────────────────────────────────
backend → AppleScript → Mail.app      backend → local IMAP/SMTP → DavMail → Exchange
(drives the GUI, ~1 s per email)      (standard protocols, ~236 ms per email)
```

For MailAgent, enabling DavMail means the whole mailbox-access chain **no longer depends on the Mail.app GUI**—the backend fetches over standard IMAP, sends over SMTP, and reads the calendar over CalDAV. DavMail stays resident in the background, maintaining the OAuth session with the Exchange server.

## Why we recommend it

| Dimension | DavMail (recommended) | AppleScript (fallback) |
|---|---|---|
| **Fetch speed** | ~236 ms per email (IMAP `UID FETCH`) | ~1 s per email (drives Mail.app) |
| **GUI dependency** | None—Mail.app need not be open/foreground | Requires Mail.app signed in and running |
| **Rich-text Reply All** | Works properly: `multipart/alternative` + `In-Reply-To`, folds into the original conversation on the Outlook side | GUI injection is limited; rich text / thread folding is unreliable |
| **Multi-folder sync** | Supported (selected custom Exchange folders join the main pipeline) | Not supported |
| **Direct CalDAV calendar read** | Supported (reads the Outlook server-side calendar directly) | Not supported |
| **System permissions** | Almost no macOS Automation / Accessibility permissions needed | Needs the full set: Full Disk Access + Automation + Accessibility, etc. |
| **Cross-platform** | Standard protocols, paves the way for a future Linux deployment | Locked to macOS + Mail.app |

In one line: **Exchange users get a clearly better experience with DavMail.** AppleScript remains the zero-extra-component, always-available fallback—change `MAILAGENT_BACKEND` back to `applescript` at any time to switch back.

## Prerequisites

- A **Java runtime** (JRE/JDK 8+). Verify with `java -version`—if it prints a version, you are good. If not, `brew install openjdk` (no sudo needed on macOS), or use DavMail's bundled `davmail azul` to fetch an embedded JRE.
- **DavMail 6.7.0** (the jar). This repo ships it at `davmail-poc/jar/davmail.jar`; you can also download it from [davmail.sourceforge.net](https://davmail.sourceforge.net/).
- A **corporate Exchange / Microsoft 365 mailbox**, on a tenant that allows OAuth sign-in (see the broker-check note in Step 2).

## Step 1: Write `davmail.properties`

DavMail uses a `.properties` file to describe its listening ports, OAuth mode, and credential path. Write the following into `davmail-poc/config/davmail.properties`:

```properties
# ===== O365 OAuth2 mode =====
# O365Manual: on startup, prints an OAuth URL; you go through MFA in the browser
# and paste the redirect URL back into stdin.
davmail.mode=O365Manual
davmail.url=https://outlook.office365.com/EWS/Exchange.asmx

# OAuth token persistence path (use an absolute path)
davmail.oauth.tokenFilePath=/absolute/path/MailAgent/davmail-poc/token/token.dat

# ===== Impersonate the Outlook for Windows well-known client_id =====
# Sign in with the Outlook desktop public client_id to get past the
# "third-party apps need IT approval" hurdle.
davmail.oauth.clientId=d3590ed6-52b3-4102-aeff-aad2292ab01c
davmail.oauth.redirectUri=urn:ietf:wg:oauth:2.0:oob

# ===== Listening ports (IMAP + SMTP + CalDAV) =====
davmail.imapPort=1143
davmail.smtpPort=1025
davmail.caldavPort=1080
davmail.ldapPort=0
davmail.popPort=0

# ===== Server mode (no tray icon, suited for a background daemon) =====
davmail.server=true
davmail.disableUpdateCheck=true

# Local plaintext communication (stays within the host), TLS off
davmail.smtpStartTls=false
davmail.imapStartTls=false
```

:::caution[Java Properties does not support inline comments]
A `#` must be on **its own line**. Writing `davmail.imapPort=1143  # IMAP` makes `  # IMAP` part of the port value and the port fails to parse.
:::

Those two `client_id` lines are the key; the next step explains why they are filled in this way.

## Step 2: First-time OAuth authentication (impersonating the Outlook client_id)

### Why impersonate the client_id

DavMail's built-in default client_id is its own self-registered third-party app, which most corporate tenants treat as a standalone third-party app requiring IT approval. The **Outlook for Windows public client_id (`d3590ed6-52b3-4102-aeff-aad2292ab01c`)**, on the other hand, is Microsoft's official desktop client and is usually already trusted in the tenant—signing in with it gets you an EWS token directly, bypassing the approval hurdle.

### The authentication flow

Run DavMail once in the **foreground** and watch the console:

```bash
cd ~/Documents/MailAgent/davmail-poc/jar
java -jar davmail.jar ../config/davmail.properties
```

1. The console prints an **OAuth URL** (you can see `client_id=d3590ed6-...` and your `login_hint` inside it).
2. Copy the URL → open it in a browser → enter your **corporate account + MFA**.
3. Microsoft may show a **broker check**: "Are you trying to sign in to Microsoft Office? Only continue if you downloaded the app from a store or website you trust."—click **Continue**.
   > This happens because the client_id corresponds to Outlook for Windows, but the current process is not real Outlook (it has no Microsoft device signature), triggering an app-authenticity double check. Being able to click "Continue" through it is precisely the sign that your tenant **does not enforce a device-bound check on this client_id**.
4. After Continue, you land on a **perpetually loading blank page** (`urn:ietf:wg:oauth:2.0:oob` is a redirect style modern browsers no longer support natively, so the page hangs—this is expected).
5. **Extract the authorization code from the stuck page**: open the browser **DevTools → Network tab** → find the last **failed/pending request** → copy the `code=...` parameter from its Request URL.
6. **Paste the full `code=...` back into DavMail's console stdin** and press Enter.
7. DavMail exchanges that code for an access token, establishes a session with Exchange, and writes the credentials to `token/token.dat` (~2 KB). The **refresh token is valid for 90 days by default**, so restarts after that don't need re-authorization.

When the console stops asking for authorization and `token.dat` is created, authentication succeeded. You can `Ctrl-C` to stop this foreground run; Step 5 turns it into a daemon with PM2.

:::note
DavMail's current sign-in via the Outlook desktop well-known client_id is for evaluation use; for corporate production, go through your company's IT approval or apply for a Graph API app. Also, Microsoft has announced that EWS for O365 will be **shut down on 2026-10-01**, at which point you'll need to move to the Graph route. The AppleScript path is unaffected by either and is always available as a fallback.
:::

## Step 3: Point MailAgent at DavMail

**Desktop App users**: fill in the DavMail settings (mailbox address, ports, Cipher Key) in the App's **Settings panel**—no need to edit `.env` manually.

**Developers running the backend from source**: back in `~/Documents/MailAgent/.env`, switch the backend to davmail and add a few values (each parameter maps one-to-one to the App's Settings panel):

```bash
MAILAGENT_BACKEND=davmail
DAVMAIL_USER=your@company.com          # usually the same as USER_EMAIL
DAVMAIL_CIPHER_KEY=any-fixed-string     # token encryption key, see warning below
DAVMAIL_IMAP_PORT=1143                  # must match davmail.properties
DAVMAIL_SMTP_PORT=1025
DAVMAIL_ROOT=/absolute/path/MailAgent/davmail-poc   # absolute path required for the packaged App
```

:::caution[`DAVMAIL_CIPHER_KEY` must be identical across all clients and all restarts]
DavMail uses the **AUTH password the client provides on connection** as the key to encrypt `token.dat`. MailAgent's components (mail-sync, the CLI, the frontend) all connect to the same DavMail, so **they must use the same cipher key**, or the credentials can't be decrypted—it throws `BadPaddingException` and forces a fresh OAuth round. The key can be any string, but once chosen it must not change across components or restarts.
:::

When running from source, restart mail-sync to pick up the new backend:

```bash
pm2 restart mail-sync
```

## Step 4: Confirm DavMail is running

```bash
# 1) Are the ports up (IMAP / SMTP)?
nc -zv localhost 1143      # IMAP, expect succeeded
nc -zv localhost 1025      # SMTP, expect succeeded

# 2) No auth errors in the DavMail log
tail -n 30 ~/Documents/MailAgent/davmail-poc/logs/davmail.log

# 3) The token is on disk and recent
ls -la ~/Documents/MailAgent/davmail-poc/token/token.dat

# 4) Test that IMAP login actually works (replace KEY with your DAVMAIL_CIPHER_KEY)
python3 - <<'PY'
import imaplib
m = imaplib.IMAP4("localhost", 1143)
m.login("your@company.com", "KEY")   # password is DAVMAIL_CIPHER_KEY
print(m.list()[0])                    # OK means the auth chain is working
m.logout()
PY
```

Then confirm the MailAgent backend is healthy overall:

```bash
mailagent admin health -o json | jq .data.healthy   # expect true
tail -f logs/sync.log                                # there should be no ERROR lines
```

## Step 5: Daemonize DavMail (PM2)

DavMail needs to stay running in the background for MailAgent to send and receive at any time. Use PM2 to keep it resident, start on boot, and restart on crash. **Daemonize the `java` process directly** (don't rely on a foreground terminal):

```bash
pm2 start "$(which java)" --name davmail-poc -- \
  -Xmx512M -Dsun.net.inetaddr.ttl=60 \
  -jar ~/Documents/MailAgent/davmail-poc/jar/davmail.jar \
  ~/Documents/MailAgent/davmail-poc/config/davmail.properties

pm2 save        # persist the process list
pm2 startup     # run the printed command once to enable start-on-boot
```

Common maintenance commands:

```bash
pm2 status                      # check whether davmail-poc is online
pm2 logs davmail-poc            # tail DavMail output
pm2 restart davmail-poc         # restart (after editing properties)
```

:::tip[Startup order]
DavMail must come up before mail-sync. Once both are under PM2 and you've run `pm2 save`, PM2 brings them up together on boot—no manual ordering needed.
:::

### What to do when the token expires

The refresh token in `token.dat` is valid for 90 days by default and DavMail renews it automatically, so normally you don't touch it. But if your device is **removed from the tenant** by an administrator, the refresh token is **permanently invalidated** (the log shows `AADSTS700003`)—automatic renewal can't recover it, and you must **redo the interactive authentication from Step 2**: delete the old `token.dat`, run DavMail in the foreground once to re-authorize, then `pm2 restart davmail-poc`.

> Alternative daemon methods: DavMail 6.7's bundled `davmail` launcher script (`davmail <properties path> -notray`) or the community Docker image also work, but daemonizing the native `java` process with PM2 is the method validated in this project.

## Next up

Once DavMail is working, the next step is **[In-App First-Time Setup](/en/101/onboarding/)**—fill in your keys, choose an AI backend inside the App, and you're ready for daily use.

---

> Learn more: [(Developer) Run the Backend from Source](/en/101/install-backend/) · [Architecture Core (Sprint 16 dual-backend)](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/architecture/architecture-internals.md) · [EWS Shutdown Migration Roadmap §5.1](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/architecture/roadmap-post-cutover.md)
