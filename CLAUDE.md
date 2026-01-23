# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**MailAgent** is a real-time synchronization system that automatically syncs:
1. **Emails** from macOS Mail.app to Notion
2. **Calendar events** from macOS Calendar.app (Exchange) to Notion

Enabling AI-powered classification, analysis, and reply suggestions.

**Tech Stack:**
- Python 3.11+ with asyncio
- AppleScript for Mail.app integration
- EventKit (pyobjc) for Calendar.app integration
- Notion API (notion-client)
- BeautifulSoup/lxml for HTML parsing
- Pydantic for configuration management

## Commands

### Environment Setup
```bash
# Activate virtual environment (required for all commands)
source venv/bin/activate

# Install/update dependencies
pip install -r requirements.txt
```

### Testing & Development
```bash
# Test Notion API connection
python3 scripts/test_notion_api.py

# Test Mail.app email reading
python3 scripts/test_mail_reader.py

# Manually sync one email (interactive)
python3 scripts/manual_sync.py

# Debug Mail.app structure (find correct mailbox names)
python3 scripts/debug_mail_structure.py

# Inspect latest unread email details
python3 scripts/inspect_latest_email.py

# Test attachment handling
python3 scripts/test_attachments.py

# Test EventKit calendar reading
python3 scripts/test_eventkit.py

# Debug EventKit raw data
python3 scripts/debug_eventkit.py
```

### Running the Services
```bash
# Run email sync in foreground (for testing)
python3 main.py

# Run calendar sync once
python3 calendar_main.py --once

# Run calendar sync daemon (continuous)
python3 calendar_main.py

# View logs in real-time
tail -f logs/sync.log
```

### Running with PM2 (Recommended for Production)
```bash
# Install PM2 if not already installed
npm install -g pm2

# Start email sync service
pm2 start main.py --name mail-sync --interpreter python3 --cwd /Users/chenyuanquan/Documents/MailAgent

# Start calendar sync service
pm2 start calendar_main.py --name calendar-sync --interpreter python3 --cwd /Users/chenyuanquan/Documents/MailAgent

# Save PM2 process list (auto-restart on reboot)
pm2 save

# Setup PM2 startup script (run on system boot)
pm2 startup

# View status
pm2 status

# View logs
pm2 logs mail-sync
pm2 logs calendar-sync

# Restart services
pm2 restart mail-sync
pm2 restart calendar-sync

# Stop services
pm2 stop all
```

## Architecture

### Core Data Flow

```
Mail.app → EmailReader → NotionSync → Notion Database
           (AppleScript)  (HTML Conv)  (Pages + Blocks)
                              ↓
                         Attachments → File Upload API

Calendar.app → CalendarReader → CalendarNotionSync → Notion Database
               (EventKit)       (Description Parser)  (Pages + Blocks)
                                       ↓
                              Teams Meeting → URL + Formatted Content
```

### Key Components

**1. Email Reading Layer (`src/mail/`)**
- `applescript.py`: AppleScript executor for Mail.app operations
  - Uses subprocess to run osascript commands
  - 120s timeout for large HTML emails
  - Returns structured data via delimiter-separated strings
- `reader.py`: Email data extraction
  - **Critical**: Extracts HTML content from email source (not plain text)
  - Parses RFC 822 email source to get HTML body and thread metadata
  - Handles attachments by saving to temp directory with MD5 hashing
  - Extracts Thread ID from `References` or `In-Reply-To` headers
- `watcher.py`: Polling-based new email detection
  - Maintains in-memory set of seen Message IDs
  - Polls every `check_interval` seconds (default: 5s)

**2. Calendar Reading Layer (`src/calendar/`)**
- `reader.py`: EventKit-based calendar reader
  - Uses pyobjc-framework-EventKit for native macOS Calendar access
  - Reads Exchange calendar events synced to Calendar.app
  - Handles timezone conversion (event's original timezone preserved)
  - Extracts attendees, organizer, recurrence rules
  - Stores raw description for Teams meeting parsing
  - **Recurring Events**: Uses `calendarItemIdentifier + occurrenceDate` as unique ID
    - Each instance of a recurring meeting gets its own Notion page
    - Format: `{base_id}_{timestamp}` (e.g., `ABC123_1737532800`)
    - Allows separate meeting notes for each occurrence

**3. Content Conversion Layer (`src/converter/`)**
- `html_converter.py`: Converts HTML to Notion blocks
  - **Critical**: Maps inline images via CID references to uploaded file IDs
  - Handles tables, lists, headings, quotes, code blocks
  - Truncates text by UTF-16 length (Notion's requirement)
  - Max 100 blocks per request (Notion API limit)
- `eml_generator.py`: Creates RFC 822 .eml files for archival

**4. Calendar Description Parser (`src/calendar_notion/description_parser.py`)**
- Feature-based Teams meeting detection (not fixed format matching)
- Supports multiple Teams URL formats:
  - New format: `https://teams.microsoft.com/meet/{id}?p={key}`
  - Old format: `https://teams.microsoft.com/l/meetup-join/...`
  - SafeLinks wrapped URLs
- Multi-language support for Meeting ID and Passcode extraction
- Table detection and reconstruction for ABR-style schedules
- Generates formatted Notion blocks with clickable join links

**5. Notion Sync Layer (`src/notion/`, `src/calendar_notion/`)**
- `client.py`: Notion API wrapper for emails
- `sync.py`: Email-to-Notion sync orchestration
- `calendar_notion/sync.py`: Calendar-to-Notion sync
  - Creates/updates pages with event properties
  - Writes formatted description to page body (not just text property)
  - Extracts Teams join URL to URL property for quick access
  - Handles all-day and multi-day events correctly
  - **Smart Update Detection**: Avoids unnecessary updates
    - Compares `last_modified` at minute precision (Notion limitation)
    - Uses `Last Synced` field to track sync state for events without modification time
    - Only updates when event has actually changed

### Teams Meeting Parsing (Critical)

The parser uses **feature-based recognition** instead of fixed format matching:

```python
# Core patterns (language-agnostic)
TEAMS_URL_PATTERNS = [
    r'https://teams\.microsoft\.com/meet/\d+\?p=[A-Za-z0-9]+',  # New format
    r'https://teams\.microsoft\.com/l/meetup-join/...',          # Old format
]

MEETING_ID_PATTERNS = [
    r'(?:Meeting\s*ID|会议\s*ID|会议ID)\s*[:：]\s*([\d\s]{10,25})',
]

PASSCODE_PATTERNS = [
    r'(?:Passcode|Password|Pass code|密码)\s*[:：]\s*(\S{4,20})',
]
```

Supports variations:
- `Microsoft Teams 会议` / `Microsoft Teams meeting` / `Microsoft Teams Meeting`
- `加入:` / `Join:`
- `会议 ID:` / `Meeting ID:`
- `密码:` / `Passcode:`

### Configuration System

Uses Pydantic settings with `.env` file:

**Email Settings:**
- `MAIL_INBOX_NAME`: Must match exact mailbox name (e.g., "收件箱")
- `CHECK_INTERVAL`: Polling interval in seconds
- `MAX_ATTACHMENT_SIZE`: 20MB (Notion's limit)
- `SYNC_EXISTING_UNREAD`: Whether to sync backlog on startup

**Calendar Settings:**
- `CALENDAR_DATABASE_ID`: Notion database ID for calendar events
- `CALENDAR_NAME`: Calendar name in Calendar.app (e.g., "日历")
- `CALENDAR_CHECK_INTERVAL`: Sync interval in seconds (default: 300)
- `CALENDAR_PAST_DAYS`: How many days in the past to sync (default: 90)
- `CALENDAR_FUTURE_DAYS`: How many days in the future to sync (default: 90)

## Notion Database Schema

### Email Database
Required properties (case-sensitive):
- `Subject` (Title)
- `From` (Email)
- `From Name` (Text)
- `To`, `CC` (Text)
- `Date` (Date)
- `Message ID` (Text) - used for deduplication
- `Thread ID` (Text) - for conversation grouping
- `Processing Status` (Select: "未处理", "已完成")
- `Is Read`, `Is Flagged`, `Has Attachments` (Checkbox)
- `Original EML` (Files)

### Calendar Database
Required properties:
- `Title` (Title) - Event title
- `Event ID` (Text) - Unique identifier for deduplication
- `Calendar` (Select) - Calendar source (e.g., "Exchange")
- `Time` (Date) - Start and end time (supports date range)
- `Is All Day` (Checkbox)
- `Status` (Select: "confirmed", "tentative", "cancelled")
- `Location` (Text)
- `URL` (URL) - Teams meeting join link (auto-extracted)
- `Organizer` (Text)
- `Organizer Email` (Email)
- `Attendees` (Text)
- `Attendee Count` (Number)
- `Is Recurring` (Checkbox)
- `Recurrence Rule` (Text)
- `Last Modified` (Date)
- `Last Synced` (Date)
- `Sync Status` (Select: "synced", "error")

## Common Issues

**"不能获得 mailbox" error:**
- Wrong `MAIL_INBOX_NAME` in .env
- Run `debug_mail_structure.py` to find correct name

**Calendar access denied:**
- Grant calendar access in System Settings > Privacy & Security > Calendar
- Run `python3 scripts/test_eventkit.py` in Terminal to trigger permission dialog

**Teams meeting not detected:**
- Check if the event has a description with Teams info
- Verify the Teams format is supported (new/old format)
- Check logs for parsing errors

**Wrong timezone on calendar events:**
- Events use their original timezone (e.g., Asia/Shanghai)
- System timezone doesn't affect event times

**All-day events showing wrong dates:**
- All-day events use date-only format (no time component)
- Multi-day events include both start and end dates

## Development Workflow

1. **Modifying email parsing:**
   - Edit `src/mail/reader.py`
   - Test with `scripts/test_mail_reader.py`

2. **Modifying calendar parsing:**
   - Edit `src/calendar/reader.py`
   - Test with `scripts/test_eventkit.py`

3. **Changing Teams meeting detection:**
   - Edit `src/calendar_notion/description_parser.py`
   - Add new patterns to `TEAMS_URL_PATTERNS`, `MEETING_ID_PATTERNS`, etc.

4. **Adding new features:**
   - Update `src/models.py` if data model changes
   - Update Notion database schema if properties change
   - Add validation in `src/config.py` if new config needed

## File Locations

- **Logs**: `logs/sync.log` (rotated at 10MB, 7-day retention)
- **Temp attachments**: `/tmp/email-notion-sync/{md5}/`
- **Config**: `.env` (never commit with real tokens)
- **Entry points**: `main.py` (email), `calendar_main.py` (calendar)
