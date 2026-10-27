# FacebookSwift ⚡

**A Facebook Media Downloader for Chrome**

FacebookSwift is a Chrome extension designed to simplify downloading supported Facebook media. It provides bulk profile scanning alongside individual post, photo, video, Reel, and Story download options.

## ✨ Features

### 📦 Bulk Profile Download
- Scan profile posts and photos in bulk.
- Scan Reels separately.
- Organize detected media into three groups:
  - **Posts & Photos** — media discovered from profile posts and photo collections.
  - **Unique Reels** — Reels not already detected in the posts collection.
  - **Duplicate Media** — media identified in both collections.
- Download supported media in bulk.
- Support profile URLs using usernames and `profile.php?id=...` formats.

### 📥 Single Media Download
- Download an individual Facebook post's supported media.
- Download individual photos and videos.
- Download supported Reels and Watch videos.
- Add download buttons to supported timeline posts and media views.
- Detect media from supported Facebook pages.

### 📱 Story Download
- Provide manual download actions for supported Stories.
- Resolve media discovered while browsing supported Facebook pages.
- Download Story media when a usable media URL is available.

### ⚡ Additional Features
- Chrome Extension Manifest V3.
- Background download queue.
- Media deduplication using identifiers and fingerprints.
- Automatic media detection while browsing Facebook.
- Floating download interface for supported profile pages.
- Support for Facebook's modern and legacy profile URL formats.

## 🛠️ Built With

- JavaScript
- HTML5
- CSS3
- Chrome Extensions API
- Chrome Extension Manifest V3

## 📂 Project Structure

```text
FacebookSwift/
├── icons/
├── background.js
├── content.js
├── interceptor.js
├── manifest.json
├── offscreen.html
├── offscreen.js
├── popup.html
├── popup.js
└── style.css
```

## 🚀 Installation

1. Download or clone this repository.
2. Open Google Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the extracted `FacebookSwift` project folder.
6. Open Facebook and navigate to a supported profile or media page.
7. Use the available download buttons.

## 📖 How to Use

### Bulk Profile Download

1. Open a Facebook profile.
2. Click the **Download All** button.
3. Allow FacebookSwift to scan available posts and Reels.
4. Review the detected media groups.
5. Start the download process.

### Single Post, Photo, Video, or Reel

1. Open the desired Facebook post, photo, video, or Reel.
2. Use the download button provided by FacebookSwift.
3. Save the media through Chrome's download system.

### Story Download

1. Open a supported Facebook Story.
2. Use the available Story download action.
3. Save the media if FacebookSwift successfully resolves its source.

## ⚠️ Limitations

- Download availability depends on Facebook's current website structure and media access.
- Private, restricted, expired, or unavailable content may not be downloadable.
- Facebook may change its internal APIs and page structure, affecting functionality.
- Bulk scans can only collect media the extension can discover and resolve.
- Some videos may need to be opened first for their media source to become available.
- Chrome permissions and download settings may affect results.

## 🔐 Privacy

FacebookSwift is designed to process media through the user's browser session.

Review the source code and requested extension permissions before installation. Never share your Facebook password, session cookies, or authentication tokens with third-party services.

## ⚖️ Disclaimer

FacebookSwift is an independent, third-party browser extension and is not affiliated with, endorsed by, or officially connected to Facebook or Meta.

Use the extension responsibly. Download only content you own or have permission to save, and respect applicable copyright laws, privacy rights, and platform terms.

## 📄 License

See the [LICENSE](LICENSE) file for licensing details.

---

**FacebookSwift — Simplifying Facebook Media Downloads.**
