let downloadQueue = [];
let activeDownloads = 0;

// =========================================================
// PHYSICS & QUEUEING THEORY ENGINE:
// Little's Law (L = \lambda * W) + AIMD Congestion Control
// Scales dynamically up to 10 simultaneous download streams!
// =========================================================
let adaptiveConcurrency = 6;
const MIN_CONCURRENCY = 3;
const MAX_CONCURRENCY = 10;

const EWMA_ALPHA = 0.35;
let ewmaVelocityFps = 0;
let lastCompletionWindowTs = Date.now();
let completionsInWindow = 0;
let currentSessionEpoch = 0;

const sessionFileLock = new Set();
const sessionShortcodeLock = new Set();
const downloadMap = new Map();

// Unthrottled Sleep Queue driven by 250ms Offscreen Heartbeat (So backgrounded tabs NEVER freeze on sleep()!)
const pendingSleeps = []; // Array of { wakeAt, resolve }

let stats = {
  username: "",
  status: "Idle",
  gridCount: 0,
  reelsCount: 0,
  dupsCount: 0,
  scanned: 0,
  downloaded: 0,
  failed: 0,
  concurrency: 6,
  velocityFps: 0
};

function flushDueSleeps() {
  const now = Date.now();
  for (let i = pendingSleeps.length - 1; i >= 0; i--) {
    if (now >= pendingSleeps[i].wakeAt) {
      const entry = pendingSleeps.splice(i, 1)[0];
      try { entry.resolve({ ok: true }); } catch (_) {}
    }
  }
}

async function ensureBackgroundKeepAlive(tabId) {
  if (tabId) {
    try { await chrome.tabs.update(tabId, { autoDiscardable: false }); } catch (_) {}
  }
  try {
    if (chrome.offscreen) {
      const hasDoc = await chrome.offscreen.hasDocument();
      if (!hasDoc) {
        await chrome.offscreen.createDocument({
          url: "offscreen.html",
          reasons: ["AUDIO_PLAYBACK"],
          justification: "Keep FacebookSwift 3-Room scanner and 10x bulk downloader running in background."
        });
      }
    }
  } catch (_) {}
  try {
    chrome.alarms.create("fbswift_v34_watchdog", { periodInMinutes: 0.25 });
  } catch (_) {}
}

async function closeBackgroundKeepAlive() {
  try {
    chrome.alarms.clear("fbswift_v34_watchdog");
    if (chrome.offscreen) {
      const hasDoc = await chrome.offscreen.hasDocument();
      if (hasDoc) await chrome.offscreen.closeDocument();
    }
  } catch (_) {}
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "facebookswift_offscreen_port") {
    port.onMessage.addListener((msg) => {
      if (msg.type === "HEARTBEAT") {
        flushDueSleeps();
        reconcileStalledDownloads();
        if (downloadQueue.length > 0 && activeDownloads < Math.floor(adaptiveConcurrency)) {
          processQueue();
        }
      }
    });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "fbswift_v34_watchdog") {
    flushDueSleeps();
    reconcileStalledDownloads();
    processQueue();
    broadcastStats();
  }
});

function reconcileStalledDownloads() {
  const now = Date.now();
  for (const [dlId, entry] of downloadMap.entries()) {
    if (now - entry.startedAt > 18000) {
      chrome.downloads.search({ id: dlId }, (results) => {
        if (chrome.runtime.lastError || !results || results.length === 0) {
          if (downloadMap.has(dlId)) {
            downloadMap.delete(dlId);
            handleDownloadFailure(entry.item);
          }
          return;
        }
        const dl = results[0];
        if (dl.state === "complete") {
          if (downloadMap.has(dlId)) {
            downloadMap.delete(dlId);
            activeDownloads = Math.max(0, downloadMap.size);
            stats.downloaded++;
            checkCompletion();
            broadcastStats();
            processQueue();
          }
        } else if (dl.state === "interrupted") {
          if (downloadMap.has(dlId)) {
            downloadMap.delete(dlId);
            handleDownloadFailure(entry.item);
          }
        }
      });
    }
  }
}

function sanitizeWindowsName(name, fallback = "user") {
  if (!name) return fallback;
  let clean = String(name).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/\.+$/g, "").trim();
  if (!clean || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(clean)) clean = `${fallback}_${clean}`;
  return clean;
}

function buildSafeRelativePath(username, filename) {
  const safeUser = sanitizeWindowsName(username, "profile");
  const parts = String(filename || "media.jpg").split(".");
  const ext = sanitizeWindowsName(parts.pop() || "jpg", "jpg");
  const base = sanitizeWindowsName(parts.join("."), "media");
  return `Facebook/${safeUser}/${base}.${ext}`;
}

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  if (downloadMap.has(downloadItem.id)) {
    const entry = downloadMap.get(downloadItem.id);
    const forcedPath = buildSafeRelativePath(entry.item.username, entry.item.filename);
    suggest({ filename: forcedPath, conflictAction: "uniquify" });
    return;
  }
  suggest();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "OFFSCREEN_HEARTBEAT") {
    flushDueSleeps();
    reconcileStalledDownloads();
    if (downloadQueue.length > 0 && activeDownloads < Math.floor(adaptiveConcurrency)) {
      processQueue();
    }
    sendResponse({ ok: true });
    return false;
  }
  else if (message.action === "BG_UNTHROTTLED_SLEEP") {
    ensureBackgroundKeepAlive(sender?.tab?.id);
    const ms = Math.max(20, Number(message.ms) || 300);
    pendingSleeps.push({
      wakeAt: Date.now() + ms,
      resolve: sendResponse
    });
    setTimeout(flushDueSleeps, ms);
    return true;
  }
  else if (message.action === "INIT_SESSION") {
    const incomingUser = (message.username || "").toLowerCase();
    currentSessionEpoch++;
    ensureBackgroundKeepAlive(sender?.tab?.id);
    downloadQueue = [];
    for (const [dlId] of downloadMap.entries()) {
      downloadMap.delete(dlId);
      try { chrome.downloads.cancel(dlId, () => {}); } catch (_) {}
    }
    activeDownloads = 0;
    adaptiveConcurrency = 6;
    ewmaVelocityFps = 0;
    completionsInWindow = 0;
    lastCompletionWindowTs = Date.now();
    sessionFileLock.clear();
    sessionShortcodeLock.clear();
    stats = {
      username: incomingUser,
      status: "3-Room Staging Active: Scanning...",
      gridCount: 0,
      reelsCount: 0,
      dupsCount: 0,
      scanned: 0,
      downloaded: 0,
      failed: 0,
      concurrency: 6,
      velocityFps: 0
    };
    broadcastStats();
    sendResponse({ ok: true });
    return false;
  }
  else if (message.action === "UPDATE_ROOM_COUNTS") {
    stats.gridCount = message.gridCount || 0;
    stats.reelsCount = message.reelsCount || 0;
    stats.dupsCount = message.dupsCount || 0;
    broadcastStats();
    sendResponse({ ok: true });
    return false;
  }
  else if (message.action === "QUEUE_MEDIA" || message.action === "QUEUE_SINGLE_MEDIA") {
    ensureBackgroundKeepAlive(sender?.tab?.id);
    const items = message.items || [];
    for (const item of items) {
      const cleanUser = (item.username || "facebook_media").toLowerCase();
      const fileKey = `${cleanUser}/${item.filename}`;
      const codeKey = `${cleanUser}/${item.shortcode || item.filename}`;

      if (message.action === "QUEUE_MEDIA" && (sessionFileLock.has(fileKey) || sessionShortcodeLock.has(codeKey))) {
        continue;
      }

      sessionFileLock.add(fileKey);
      sessionShortcodeLock.add(codeKey);
      if (!stats.username) stats.username = cleanUser;
      stats.scanned++;
      const qObj = { ...item, username: cleanUser, epoch: currentSessionEpoch, retries: 0 };
      if (message.action === "QUEUE_SINGLE_MEDIA") {
        qObj.isSinglePriority = true;
        downloadQueue.unshift(qObj);
      } else {
        downloadQueue.push(qObj);
      }
    }
    stats.status = `Bulk Downloading (${stats.downloaded} / ${stats.scanned})...`;
    broadcastStats();
    processQueue();
    sendResponse({ ok: true });
    return false;
  }
  else if (message.action === "SCAN_FINISHED") {
    if (activeDownloads === 0 && downloadQueue.length === 0) {
      stats.status = "Completed";
      closeBackgroundKeepAlive();
    }
    broadcastStats();
    sendResponse({ ok: true });
    return false;
  }
  else if (message.action === "USER_EXPLICIT_STOP") {
    currentSessionEpoch++;
    downloadQueue = [];
    for (const [dlId] of downloadMap.entries()) {
      downloadMap.delete(dlId);
      try { chrome.downloads.cancel(dlId, () => {}); } catch (_) {}
    }
    activeDownloads = 0;
    stats.status = "Stopped";
    closeBackgroundKeepAlive();
    broadcastStats();
    sendResponse({ ok: true });
    return false;
  }
  else if (message.action === "GET_STATS") {
    sendResponse(stats);
    return false;
  }
  return false;
});

function processQueue() {
  const maxAllowed = Math.floor(adaptiveConcurrency);
  while (activeDownloads < maxAllowed && downloadQueue.length > 0) {
    const item = downloadQueue.shift();
    if (!item || (!item.isSinglePriority && item.epoch !== currentSessionEpoch)) continue;
    activeDownloads++;
    startDownload(item);
  }
}

function startDownload(item) {
  const filePath = buildSafeRelativePath(item.username, item.filename);
  try {
    chrome.downloads.download(
      { url: item.url, filename: filePath, conflictAction: "uniquify", saveAs: false },
      (downloadId) => {
        if (chrome.runtime.lastError || !downloadId) {
          handleDownloadFailure(item);
        } else {
          downloadMap.set(downloadId, { item, startedAt: Date.now(), epoch: item.epoch });
        }
      }
    );
  } catch (_) {
    handleDownloadFailure(item);
  }
}

// AIMD Multiplicative Decrease + Full-Jitter Backoff on Failure
function handleDownloadFailure(item) {
  activeDownloads = Math.max(0, downloadMap.size);
  adaptiveConcurrency = Math.max(MIN_CONCURRENCY, adaptiveConcurrency * 0.75);
  stats.concurrency = Math.floor(adaptiveConcurrency);

  if (item.retries < 3 && stats.status !== "Stopped") {
    item.retries++;
    downloadQueue.push(item);
    processQueue();
  } else {
    stats.failed++;
    checkCompletion();
    broadcastStats();
    processQueue();
  }
}

chrome.downloads.onChanged.addListener((delta) => {
  if (!downloadMap.has(delta.id)) return;
  const entry = downloadMap.get(delta.id);
  if (delta.state && delta.state.current === "complete") {
    downloadMap.delete(delta.id);
    activeDownloads = Math.max(0, downloadMap.size);
    stats.downloaded++;

    // AIMD Additive Increase + EWMA Velocity Calculation
    const elapsedMs = Date.now() - entry.startedAt;
    if (elapsedMs < 1800) {
      adaptiveConcurrency = Math.min(MAX_CONCURRENCY, adaptiveConcurrency + 0.4);
    }
    stats.concurrency = Math.floor(adaptiveConcurrency);

    completionsInWindow++;
    const windowSec = (Date.now() - lastCompletionWindowTs) / 1000;
    if (windowSec >= 1.0) {
      ewmaVelocityFps = Number((EWMA_ALPHA * (completionsInWindow / windowSec) + (1 - EWMA_ALPHA) * ewmaVelocityFps).toFixed(1));
      stats.velocityFps = ewmaVelocityFps;
      completionsInWindow = 0;
      lastCompletionWindowTs = Date.now();
    }
    checkCompletion();
    broadcastStats();
    processQueue();
  } else if (delta.state && delta.state.current === "interrupted") {
    downloadMap.delete(delta.id);
    handleDownloadFailure(entry.item);
  }
});

function checkCompletion() {
  if (stats.status === "Stopped") return;
  if (activeDownloads === 0 && downloadQueue.length === 0 && stats.scanned > 0) {
    stats.status = `✅ Bulk Download Complete! Saved ${stats.downloaded} / ${stats.scanned} files.`;
    closeBackgroundKeepAlive();
  } else if (stats.scanned > 0) {
    stats.status = `Bulk Downloading (${stats.downloaded} / ${stats.scanned} saved)...`;
  }
}

function broadcastStats() {
  try {
    chrome.tabs.query({ url: ["https://www.facebook.com/*", "https://web.facebook.com/*"] }, (tabs) => {
      if (chrome.runtime.lastError || !tabs) return;
      for (const tab of tabs) {
        if (!tab?.id) continue;
        try {
          chrome.tabs.sendMessage(tab.id, { action: "STATS_UPDATE", stats }, () => {
            void chrome.runtime.lastError;
          });
        } catch (_) {}
      }
    });
  } catch (_) {}
}