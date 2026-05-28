# DCInside Image Downloader - AI Handoff (Current Code Baseline: 0.0.2)

This document is machine-oriented and describes the exact behavior of the current code in `/0.0.2`.
It is intended for other AI sessions/agents to continue work without re-discovery.

## 1) Scope and Entry Points

- Manifest: `manifest.json` (MV3, service worker background).
- Content script: `content.js`.
- Background service worker: `background.js`.
- Popup UI/settings: `popup.html`, `popup.js`.
- Remote version metadata template: `version.json`.
- Version: `0.0.2`.

## 2) URL Coverage

`content.js` runs on:
- `https://gall.dcinside.com/board/view*`
- `https://gall.dcinside.com/mini/board/view*`
- `https://gall.dcinside.com/mgallery/board/view*`
- `https://gall.dcinside.com/gallery/board/view*`

## 3) Persistent Settings (chrome.storage.sync)

Keys:
- `ElementMove` (boolean, default `false`)
- `IgnoreAttachment` (boolean, default `false`)
- `OriginalImageDownload` (boolean, default `false`)
- `OriginalDownloadDelayMs` (number, default `500`, valid `0..10000`)
- `DebugMode` (boolean, default `false`)
- `filenamePattern` (string, default `?title`)

`popup.js` validation constraints for `filenamePattern`:
- max length 50
- required token `?title`
- allowed tokens: `?title`, `?id`, `?gall`, `?today`, `?wday`
- forbidden chars: `< > : " / \ | *`
- any `?` must start a valid token

`popup.js` validation constraints for `OriginalDownloadDelayMs`:
- integer milliseconds
- blank input falls back to `500`
- valid range: `0..10000`

Version check endpoints:
- primary: `https://raw.githubusercontent.com/bunta-expert/DCInside-Image-Down-Fork/main/version.json`
- fallback: `https://raw.githubusercontent.com/bunta-expert/DCInside-Image-Down-Fork/main/latest-version.txt`
- current version source: `chrome.runtime.getManifest().version`
- update action: popup button opens the remote `url`, `downloadUrl`, or `releaseUrl`; fallback URL is the repository root.

## 4) High-Level Architecture

Main model:
- `content.js` decides what to download (body images vs attachment path), inserts UI buttons, sends commands.
- `background.js` owns tab queue scheduling and `chrome.downloads` API execution.

Main communication is message-based via `chrome.runtime.sendMessage`.

## 5) Message Protocol (Current)

Messages from content to background:
- `DEBUG_LOG`
- `SET_READY`
- `CONTENT_READY`
- `OPEN_TAB`
- `OPEN_TAB_BATCH`
- `DOWNLOAD`
- `COMPLETE`

Behavior in background:
- `SET_READY`: mark current tab as non-auto (`pendingTabs` entry).
- `CONTENT_READY`: if sender tab is tracked, convert to `START_DOWNLOAD` and send back to the same tab.
- `OPEN_TAB`: enqueue one URL for auto processing.
- `OPEN_TAB_BATCH`: enqueue many URLs for auto processing.
- `DOWNLOAD`: infer extension and call `chrome.downloads.download`.
- `COMPLETE`: if auto tab, close tab and move queue; if self/manual tab, only clear tracking.

Message from background to content:
- `START_DOWNLOAD` (includes passthrough flags; may force body mode for queued series).

## 6) content.js - Functional Blocks

`content.js` is organized as multiple IIFEs plus shared helpers.

Global helpers:
- `debugLog(...)`
- `normalizeUrl(rawUrl)`
- `normalizeDcImageUrl(rawUrl)`
- `normalizeOriginalImageUrl(rawUrl)`
- `extractOriginalImageUrl(img)`
- `normalizeOriginalDelayMs(rawValue)`
- `collectImageUrls()`

### 6.1 Debug bootstrap

- Loads `DebugMode` from storage.
- Watches storage changes.
- When enabled, logs with prefix `[DCID Downloader][CS]`.
- Mirrors CS logs to background via `DEBUG_LOG`.

### 6.2 Attachment-area analysis + optional native attachment-flow button

Flow:
- Pre-collect `imageUrls = collectImageUrls()`.
- Detect `view_content_wrap` and `appending_file_box`.
- Apply `ElementMove` by moving attachment box near top.
- Compare attachment count uniqueness vs body image count.
- Insert one of:
  - `다운로드 후 종료` button (`class Later_Exit`) when counts match.
  - warning sign when mismatch.
  - error sign when unusable.
- `다운로드 후 종료` triggers native attachment button click using safe dispatch:
  - temporarily replace `javascript:` href to avoid CSP warning.
  - dispatch synthetic click.
- Observe style change on native button; when hidden, send `COMPLETE`.

### 6.3 Series UI block

Target container: `div.dc_series`.

Per-series-item behavior:
- Adds `다운로드` button next to each series link.
- Sends `OPEN_TAB` with `forceBody: true`, delay 2000ms.

Batch behavior:
- Builds unique URLs excluding current post `no`.
- If URL count > 1, inserts `전체 다운로드 (N)` button.
- Sends `OPEN_TAB_BATCH` with all URLs, delay 2000ms, `forceBody: true`.

### 6.4 Main body-download button block

Adds `본문 이미지 다운로드` button near `div.gallview_head .fr > :first-child`.
On click:
- send `SET_READY`
- send `CONTENT_READY` with `{ isEach: true, isSelf: true }`

This path always executes body-image workflow (manual current tab).

### 6.5 Download execution block (message consumer)

Initialization:
- loads `IgnoreAttachment`, `filenamePattern`, `OriginalImageDownload`, `OriginalDownloadDelayMs`
- sends initial `CONTENT_READY` (used by auto-opened tabs tracked in background)

Message handler:
- on `START_DOWNLOAD` -> `startDownloadLogic(options)`

`startDownloadLogic(options)` decision:
- if `!ignoreAttachment && !options.isEach && !options.isSelf && Later_Exit exists`
  - run attachment path (`btn.click()`), return.
- else run body path:
  - recollect latest body URLs (`collectImageUrls({ preferOriginal: OriginalImageDownload })`), fallback to initial `imageUrls`
  - call `downloadImages(urls, options)`

Folder and filename preparation:
- token replacement on folder rule:
  - `?title` from `.title_subject` or `document.title`
  - `?id` from URL param `no`
  - `?gall` from `.page_head h2 > a` normalized
  - `?today`/`?wday` via date helper
- sanitize folder path using `sanitizeFolderPath(...)`:
  - normalize separators to `/`
  - remove control chars
  - replace Windows-forbidden chars with `_`
  - trim, strip trailing dots/spaces
  - avoid reserved names (`con`, `prn`, `aux`, `nul`, `com1..9`, `lpt1..9`)
  - cap each segment length (120)
  - fallback `download`

Download dispatch:
- for each URL send `DOWNLOAD` with:
  - `url`
  - `folder`
  - `num` as zero-padded index (`001`, `002`, ...)
  - `delayMs` as `OriginalDownloadDelayMs` only when original mode is enabled, otherwise `0`
  - `preferOriginal` debug flag
- then send `COMPLETE` with current options.

### 6.6 Body image collection policy (important)

`collectImageUrls()` only keeps likely real post-body images:
- source candidates: `src`, `data-original`, `data-src`
- handles lazy placeholder `gallview_loading_ori.gif`
- excludes DCCon images (`dcimg5.dcinside.com/dccon.php?no=`)
- include only if:
  - element has `data-fileno`, OR
  - normalized URL points to DC `viewimage.php`
- deduplicates final URLs.

When `preferOriginal` is true:
- first try to extract an `imgPop('...')` URL from image `onclick`.
- also inspect closest parent link as fallback.
- convert `https://image.dcinside.com/viewimagePop.php?no=...` to direct image URL `https://image.dcinside.com/viewimage.php?id=&no=...`.
- if no original URL exists for an image, fallback to the normal body-image URL.
- debug log includes `originalFound` and `originalFallback`.

`normalizeDcImageUrl(...)` rewrites:
- any `*.dcinside.co.kr/viewimage.php?...` -> `https://image.dcinside.com/viewimage.php?...`
This is a compatibility fix for posts returning HTML/403 on old host variants.

## 7) background.js - Functional Blocks

Core state:
- tab queue: `pendingQueue`, `opening`, `autoProcessingTabId`, `nextOpenTimer`
- per-tab metadata: `pendingTabs`
- per-download metadata: `downloadMetaById`
- expected filename queue by URL: `pendingFilenameQueueByUrl`
- delayed download queue: `pendingDownloadQueue`, `downloadQueueActive`
- debug instrumentation timers: `pendingDetermineTimers`

### 7.1 Queue scheduler for series tabs

Key funcs:
- `normalizeDelayMs(rawValue)` with clamp 500..10000, default 2000.
- `queueOpenTab(url, delayMs, {forceBody})`
- `openNext()`
- `scheduleNextOpen(delayMs)`
- `onAutoTabDone(tabId, meta)`

Model:
- exactly one auto-processing tab at a time (`autoProcessingTabId`).
- next tab opens only after previous auto tab sends `COMPLETE` and is removed.

### 7.2 Runtime message router

`onMessage` branches:
- `DEBUG_LOG`: mirror CS debug.
- `OPEN_TAB` / `OPEN_TAB_BATCH`: enqueue work.
- `SET_READY`: mark manual tab tracked in `pendingTabs`.
- `CONTENT_READY`: if tab tracked, send `START_DOWNLOAD` to same tab.
  - if tab metadata has `forceBody`, mutate options to body mode (`isEach = true`, `forceBody = true`).
- `DOWNLOAD`: execute actual browser download pipeline.
- `COMPLETE`: close auto tab and continue queue, or clear manual state.

### 7.3 Download pipeline

If a `DOWNLOAD` message has `delayMs > 0`, it enters `queueDownload(...)` and is processed sequentially by `processDownloadQueue(...)`.
This is mainly used by original image mode to avoid firing many direct original requests too quickly.

1) extension inference:
- `getReliableExtension(url)`:
  - HEAD request first (5s timeout)
  - parse `content-disposition` (`filename` extension) and `content-type`
  - if HEAD status 405, fallback GET
  - fallback default `.jpg`

2) final relative path:
- `${safeFolder}/${num}.${safeExt}`
- `safeFolder`: trim and strip leading/trailing `/`
- `safeExt`: no leading dot

3) start download:
- `chrome.downloads.download({ url, filename, conflictAction: "overwrite", saveAs: false })`

4) metadata and diagnostics:
- queue expected filename by URL
- set metadata by `downloadId`
- run mismatch diagnostics and extension/timing logs when debug is on
- store `preferOriginal` in download metadata when present

### 7.4 Filename enforcement and mismatch diagnostics

`chrome.downloads.onDeterminingFilename`:
- only handles items where `downloadItem.byExtensionId === chrome.runtime.id`
- resolves expected filename from metadata or pending URL queue
- calls `suggest({ filename, conflictAction: "overwrite" })` when known

`chrome.downloads.onChanged`:
- logs state transitions
- compares actual path vs expected relative path (`endsWithRelativePath`)
- logs `"filename mismatch (possible external intervention)"` when diverged

`DETERMINE_EVENT_TIMEOUT_MS = 3000`:
- if determining callback not seen for a download id, logs potential browser/other-extension interference.

`chrome.downloads.onCreated`:
- debug-only snapshot of early filename/finalUrl/extension ownership.

## 8) Debug System

Toggle:
- `DebugMode` in popup.

Prefixes:
- content: `[DCID Downloader][CS]`
- background: `[DCID Downloader][BG]`

Important debug checkpoints:
- body image collection totals
- original image extraction totals
- series queue add/open/close
- delayed original download queue add/process
- download request path diagnostics (`analyzeRelativePath`)
- extension inference status/fallbacks
- onDeterminingFilename seen/missing
- final filename mismatch detection

## 9) Popup Version Check

`popup.js` checks remote version metadata when the popup opens.
Preferred remote file:

```json
{
  "version": "0.0.2",
  "url": "https://github.com/bunta-expert/DCInside-Image-Down-Fork",
  "message": "optional update note"
}
```

Fallback remote file (`latest-version.txt`) format:

```txt
0.0.2
https://github.com/bunta-expert/DCInside-Image-Down-Fork
optional update note
```

If remote version is greater than the manifest version, the popup shows `신규버전 다운로드`.
If remote metadata is missing or invalid, the popup shows a non-blocking failure message.

## 10) Known External Interference Pattern (Observed)

Current code includes diagnostics for Chromium-family conflicts where another extension also hooks download filename logic.
Symptom pattern:
- folder path ignored
- filename becomes server-side original/random name
- behavior differs by browser profile despite same code

This repository now logs enough detail to confirm that scenario without rollback.

## 11) Invariants for Future AI Changes

If modifying behavior, preserve these invariants unless intentionally changing product behavior:
- Series auto-download must use body-image route (`forceBody: true`).
- Manual `본문 이미지 다운로드` must stay body-route.
- Attachment route is optional/fallback and depends on `IgnoreAttachment` and `Later_Exit`.
- Relative download paths only (no absolute path).
- Folder sanitization must remain Windows-safe.
- URL normalization for `dcinside.co.kr/viewimage.php` should remain enabled.
- Do not remove debug protocol messages; they are needed for browser-specific triage.
- Keep remote version URL host permissions in sync with `popup.js` endpoints.

## 12) Quick Trace Recipes

Manual current-post body download:
1. click `본문 이미지 다운로드`
2. content -> `SET_READY` + `CONTENT_READY`
3. background -> `START_DOWNLOAD`
4. content -> collect URLs -> N x `DOWNLOAD`
5. background -> N `chrome.downloads.download`
6. content -> `COMPLETE` (`isSelf: true`)

Series batch download:
1. click `전체 다운로드 (N)`
2. content -> `OPEN_TAB_BATCH` (`forceBody: true`)
3. background opens one tab at a time (inactive)
4. tab load -> content init sends `CONTENT_READY`
5. background sees tracked tab -> sends `START_DOWNLOAD` with forced body mode
6. content downloads body images and sends `COMPLETE`
7. background closes tab and schedules next tab
