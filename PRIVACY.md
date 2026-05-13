# Privacy Policy — Whatnot Video Receipt

**Last updated: May 12, 2026**

## Overview

Whatnot Video Receipt is a browser extension that enhances the [whatnot.com](https://www.whatnot.com) shopping experience. This policy explains what data the extension accesses and how it is used.

## Data Collection

**This extension does not collect, transmit, or share any personal data.**

There are no analytics, telemetry, tracking pixels, or remote logging of any kind.

## Data Accessed

The extension reads data that is already present in your browser session on whatnot.com:

- **Order information** (order IDs, item titles, prices, dates, shipping details) — read from the page's GraphQL responses and Apollo cache solely to display in the extension's UI.
- **Seller information** (usernames, avatars, ratings) — read from page data for display purposes only.
- **Video receipt URLs** — fetched from Whatnot's own API using your existing authenticated session, solely to play the video in the extension's overlay player.

None of this data ever leaves your browser or is sent to any server other than whatnot.com's own APIs.

## Local Storage

The extension uses `chrome.storage.local` to cache order data for up to 15 minutes, reducing redundant network requests. This data is stored only on your device and is never transmitted anywhere.

## Downloads

When you use the clip or full-video download feature, the extension uses the Chrome `downloads` API to save a file directly to your device. No file is uploaded or shared externally.

## Host Permissions

The extension requests access to `whatnot.com` and related Whatnot subdomains (`api.whatnot.com`, `s3ntry.whatnot.com`, `whatnot-shipping.s3.amazonaws.com`) solely to fetch video and order data on your behalf using your existing authenticated session.

## Third-Party Services

The extension may generate links to third-party tracking services (USPS, UPS, parcelsapp.com) based on your order's shipping information. Clicking these links is optional and subject to those services' own privacy policies. No data is sent to these services automatically.

## Changes

If this policy changes materially, the version date at the top will be updated.

## Contact

This extension is an independent open-source project and is not affiliated with Whatnot, Inc. For questions, open an issue on the [GitHub repository](https://github.com/csharpengineer/whatnot-video-receipts).
