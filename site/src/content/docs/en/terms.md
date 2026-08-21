---
title: Terms of Use
description: What to know before using the MailAgent desktop App and accompanying services—the nature of the software, disclaimers, your responsibilities, and intellectual property.
---

## About this project

MailAgent is an open-source personal project ([MIT License](https://github.com/ChenyqThu/MailAgent/blob/main/LICENSE)), maintained by an individual developer, not operated on behalf of any company or commercial entity. By using this software you acknowledge and accept this.

## Provided as is

MailAgent is provided "as is," without warranty of any kind, express or implied, including but not limited to warranties of merchantability, fitness for a particular purpose, or non-infringement. The developer does not guarantee the software is free of defects or will run without interruption, and is not liable for data loss, account issues, or other losses arising from your use of the software (including any of its features—sync, AI classification, Notion mirroring, Feishu notifications, etc.). **When handling important email or business data, keep your own backups and verification in place.**

## Your responsibilities

- You are responsible for ensuring you have the right to access the mailbox you connect (Exchange / Microsoft 365 / Mail.app account) and any third-party services you use (Notion, an LLM gateway, Feishu, etc.), and for complying with each of those services' own terms.
- You are responsible for the credentials you configure into the App (API keys, Notion tokens, etc.), including keeping them safe and revoking them promptly when needed.
- Whether the DavMail bridging mode MailAgent currently uses is permitted in your enterprise environment, and whether it requires IT approval, is for you and your organization to determine.

## Notion OAuth exchange proxy

MailAgent's "Connect Notion" one-click authorization feature relies on a token-exchange proxy deployed on a server operated by MailAgent (see the [Privacy Policy](/en/privacy/) for how it handles data). This proxy is a free convenience service and does not constitute a formal service-level commitment (SLA): the developer may adjust, rate-limit, or take the service down—for maintenance, abuse mitigation, or architectural changes—without prior notice. Taking it down only affects new one-click authorizations; authorizations already completed and configuration already written to your machine are unaffected, and you can always fall back to manually creating a Notion Integration instead.

## Intellectual property

MailAgent's source code is open-sourced under the [MIT License](https://github.com/ChenyqThu/MailAgent/blob/main/LICENSE); the license text governs the specific rights and limitations.

## Changes to these terms

These terms may be updated as the project evolves; material changes will be noted in release notes. Continued use constitutes acceptance of the updated terms.

## Contact

Questions or feedback are welcome via [GitHub Issues](https://github.com/ChenyqThu/MailAgent/issues).
