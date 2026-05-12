# Whatnot Video Receipt

Chrome extension that adds a **▶ Watch Video Receipt** button to your Whatnot order pages, letting you watch the livestream recording right at the moment your item was sold.

## Features

- Injects a play button on every `whatnot.com/order/*` page
- Fetches the presigned m3u8/MP4 video via the Whatnot GraphQL API
- Shows an in-page overlay player that opens right at the sale moment (30 s before)
- Buttons to jump to the exact sale moment or rewind to the beginning of the full stream
- Keyboard shortcut: `Esc` closes the overlay

## How it works

1. Reads your order UUID from the URL
2. Calls `myOrder.videoReceipt.videoUrl` via the Whatnot GraphQL API (using your existing login session)
3. Parses the returned presigned HLS master playlist to get the full-stream MP4 URL + `TIME-OFFSET`
4. Opens a native `<video>` overlay positioned at `TIME-OFFSET` (the clip start, 30 s before the sale)

### API details

| | Value |
|---|---|
| GraphQL endpoint | `https://www.whatnot.com/services/graphql/` |
| Operation name | `GetVideoReceipt` |
| Query | `myOrder(uuid: $id) { videoReceipt { videoUrl status livestreamId } }` |
| Auth | Session cookies + `x-whatnot-app: whatnot-web` headers |
| Response `videoUrl` | `https://api.whatnot.com/api/v2/video/presigned/index_captions.m3u8?livestream_id=…&op_param=…&countdown=30` |
| Underlying storage | `https://s3ntry.whatnot.com/whatnot-livestream-videos-prod/stitched/{livestream_id}/{hash}.mp4` (CloudFront signed) |

## Installation

1. Clone / unzip this folder
2. Open `chrome://extensions/`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select this folder
5. Navigate to any `https://www.whatnot.com/order/…` page

## Notes

- You must be logged in to Whatnot for the button to work.
- The video receipt is only available for livestream orders where a recording exists.
- The `VideoReceiptInfo.status` field will be `OK` when a clip is available.
- Presigned URLs expire after ~2 hours; click the button again to refresh.
