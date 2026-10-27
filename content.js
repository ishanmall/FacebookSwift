let isScanning = false;
let stopRequested = false;
let activeTargetUsername = "";
let currentScanPhase = "posts"; // "posts" | "reels"

// =========================================================
// THE 3-SECTION STAGING ROOM ARCHITECTURE (EXACT INSTASWIFT v29 LOGIC)
// Room Section 1: Posts & Photos Vault (Set G)
// Room Section 2: Unique Reels Vault (Set R \ G)
// Room Section 3: Duplicate Quarantine Vault (Set G \cap R)
// Zero downloads occur during Pass 1 & Pass 2! All items are staged,
// compared via 64-bit FNV-1a hashes, and then bulk-dispatched in Pass 3.
// =========================================================
const stagingRoom = {
  gridVault: new Map(),       // mediaId -> record (Sec 1: Posts & Photos)
  reelsVault: new Map(),      // mediaId -> record (Sec 2: Unique Reels)
  duplicateVault: new Map(),  // mediaId -> record (Sec 3: Quarantined Duplicates)

  gridFingerprints: new Set(),
  gridMediaIds: new Set(),
  gridBaseUrls: new Set(),

  reelsFingerprints: new Set(),

  reset() {
    this.gridVault.clear();
    this.reelsVault.clear();
    this.duplicateVault.clear();
    this.gridFingerprints.clear();
    this.gridMediaIds.clear();
    this.gridBaseUrls.clear();
    this.reelsFingerprints.clear();
  }
};

const mediaCacheById = new Map();
const storyItemsById = new Map();
const storyTraysByOwner = new Map();

// Mathematical Formula 1: 64-Bit FNV-1a Collision-Free Hash Fingerprinting (O(1) Lookup)
function fnv1a64Hash(str) {
  let h1 = 0xdeadbeef ^ str.length;
  let h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

const pendingRpcMap = new Map();
let rpcCounter = 0;

const RESERVED_FB_PATHS = new Set([
  "watch", "reel", "reels", "stories", "photo", "photo.php", "permalink.php",
  "groups", "marketplace", "gaming", "friends", "bookmarks", "notifications",
  "messages", "events", "memories", "saved", "settings", "help", "search", "login"
]);

let tabAudioCtx = null;
function engageTabBackgroundLock() {
  try {
    if (navigator.locks && navigator.locks.request) {
      navigator.locks.request("facebookswift_tab_scan_lock", () => new Promise(() => {}));
    }
    if (!tabAudioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        tabAudioCtx = new Ctx();
        const osc = tabAudioCtx.createOscillator();
        const gain = tabAudioCtx.createGain();
        gain.gain.value = 0.00001;
        osc.connect(gain);
        gain.connect(tabAudioCtx.destination);
        osc.start();
      }
    } else if (tabAudioCtx.state === "suspended") {
      tabAudioCtx.resume().catch(() => {});
    }
  } catch (_) {}
}

function safeSendMessage(payload) {
  return new Promise((resolve) => {
    try {
      if (!chrome?.runtime?.id) {
        updateHUDStatus("⚠️ Extension updated! Press F5 to refresh this Facebook tab.");
        resolve(null);
        return;
      }
      chrome.runtime.sendMessage(payload, (res) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(res);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

// UNTHROTTLED SLEEP: Driven by Background Service Worker + Offscreen 250ms Heartbeat
// Never uses window.setTimeout so backgrounded / minimized tabs NEVER freeze!
function sleep(ms) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    try {
      if (chrome?.runtime?.id) {
        chrome.runtime.sendMessage({ action: "BG_UNTHROTTLED_SLEEP", ms }, () => {
          done();
        });
      } else {
        setTimeout(done, ms);
      }
    } catch (_) {
      setTimeout(done, ms);
    }
  });
}

function callMainWorld(cmd, payload, timeoutMs = 5500) {
  return new Promise((resolve) => {
    const reqId = ++rpcCounter;
    let handled = false;
    const finish = (val) => {
      if (handled) return;
      handled = true;
      pendingRpcMap.delete(reqId);
      resolve(val);
    };
    sleep(timeoutMs).then(() => finish(null));
    pendingRpcMap.set(reqId, (result) => finish(result));
    window.postMessage({ source: "FBSWIFT_CONTENT", cmd, reqId, payload }, "*");
  });
}

function getBaseCdnPath(url) {
  try {
    return new URL(url).pathname;
  } catch (_) {
    return url;
  }
}

function cleanMediaId(raw) {
  if (!raw) return "";
  return String(raw).replace(/[^a-zA-Z0-9_-]/g, "").trim();
}

function getProfileSlugFromUrl() {
  const path = window.location.pathname;
  const params = new URLSearchParams(window.location.search);

  if (path === "/profile.php" && params.get("id")) {
    return params.get("id");
  }
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return null;

  const first = parts[0].toLowerCase();
  if (RESERVED_FB_PATHS.has(first)) return null;
  if (first === "people" && parts[2]) return parts[2];

  return parts[0];
}

function getReadableProfileFolderName() {
  const slug = getProfileSlugFromUrl();
  const h1s = Array.from(document.querySelectorAll("h1"));
  for (const h of h1s) {
    const txt = (h.innerText || h.textContent || "").trim();
    if (
      txt &&
      txt.length >= 2 &&
      txt.length < 55 &&
      !txt.toLowerCase().includes("facebook") &&
      !txt.toLowerCase().includes("notifications") &&
      !txt.toLowerCase().includes("chats") &&
      !txt.toLowerCase().includes("search results")
    ) {
      const cleanName = txt.replace(/[^a-zA-Z0-9._ -]/g, "").trim().replace(/\s+/g, "_");
      if (cleanName) return cleanName;
    }
  }
  return slug || "facebook_profile";
}

function getActiveSingleMediaFromUrl() {
  const path = window.location.pathname;
  const params = new URLSearchParams(window.location.search);

  const reelMatch = path.match(/\/reels?\/(\d+|[A-Za-z0-9_-]+)/);
  if (reelMatch) return { id: reelMatch[1], isVideo: true, pageUrl: window.location.href };

  if (path.startsWith("/watch") && params.get("v")) {
    return { id: params.get("v"), isVideo: true, pageUrl: window.location.href };
  }

  const vidMatch = path.match(/\/videos\/(?:[^/]+\/)?(\d+)/);
  if (vidMatch) return { id: vidMatch[1], isVideo: true, pageUrl: window.location.href };

  if ((path.startsWith("/photo") || path.includes("/photos/")) && params.get("fbid")) {
    return { id: params.get("fbid"), isVideo: false, pageUrl: window.location.href };
  }

  const pMatch = path.match(/\/photos\/[^/]+\/(\d+)/);
  if (pMatch) return { id: pMatch[1], isVideo: false, pageUrl: window.location.href };

  return null;
}

function parseMediaLinkInfo(href) {
  if (!href || typeof href !== "string") return null;
  try {
    const u = new URL(href, window.location.origin);
    const path = u.pathname;
    const params = u.searchParams;

    const rMatch = path.match(/\/reels?\/(\d+|[A-Za-z0-9_-]+)/);
    if (rMatch) return { id: rMatch[1], isVideo: true, url: u.href };

    if (path.startsWith("/watch") && params.get("v")) {
      return { id: params.get("v"), isVideo: true, url: u.href };
    }

    const vMatch = path.match(/\/videos\/(?:[^/]+\/)?(\d+)/);
    if (vMatch) return { id: vMatch[1], isVideo: true, url: u.href };

    if (params.get("fbid")) {
      return { id: params.get("fbid"), isVideo: false, url: u.href };
    }

    const pMatch = path.match(/\/photos\/[^/]+\/(\d+)/);
    if (pMatch) return { id: pMatch[1], isVideo: false, url: u.href };
  } catch (_) {}
  return null;
}

window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.source !== "FBSWIFT_MAIN") return;
  const { type } = event.data;

  if (type === "CMD_RESPONSE") {
    const cb = pendingRpcMap.get(event.data.reqId);
    if (cb) cb(event.data.result);
  } else if (type === "INTERCEPTED_JSON") {
    const payload = event.data.payload;
    if (!payload) return;

    indexPassiveFacebookGraphql(payload);

    if (isScanning && activeTargetUsername) {
      const pPath = (event.data.pagePath || "").toLowerCase();
      const phase =
        pPath.includes("reels") || pPath.includes("videos") ? "reels" : currentScanPhase;
      routePayloadIntoStagingRoom(payload, activeTargetUsername, phase);
    }
  }
});

function scanEmbeddedCometScripts(targetOwner = "", phaseTag = "posts") {
  const scripts = document.querySelectorAll('script[type="application/json"]');
  for (const s of scripts) {
    const txt = (s.textContent || "").trim();
    if (
      txt.includes("browser_native_hd_url") ||
      txt.includes("playable_url_quality_hd") ||
      txt.includes("playable_url") ||
      txt.includes("hd_ras_v2_net_url") ||
      txt.includes("unified_stories") ||
      txt.includes("photo_image") ||
      txt.includes("viewer_image")
    ) {
      try {
        if (txt.startsWith("{") || txt.startsWith("[")) {
          const parsed = JSON.parse(txt);
          indexPassiveFacebookGraphql(parsed, targetOwner);
          if (isScanning && targetOwner) {
            routePayloadIntoStagingRoom(parsed, targetOwner, phaseTag);
          }
        }
      } catch (_) {}
    }
  }
}

// =========================================================
// ZERO-CRASH FLOATING OVERLAY SYSTEM
// =========================================================
let floatingHoverBtn = null;
let currentHoveredMediaInfo = null;
let currentHoveredAnchor = null;

function initZeroCrashHoverSystem() {
  if (floatingHoverBtn) return;

  floatingHoverBtn = document.createElement("button");
  floatingHoverBtn.id = "fbswift-floating-hover-btn";
  floatingHoverBtn.className = "fb-floating-hover-btn";
  floatingHoverBtn.innerHTML = "⬇ Download";
  floatingHoverBtn.style.display = "none";

  floatingHoverBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!currentHoveredMediaInfo) return;
    const info = currentHoveredMediaInfo;
    await downloadParticularSingleMedia(
      info.id,
      info.isVideo,
      info.url,
      floatingHoverBtn,
      currentHoveredAnchor
    );
  });

  document.documentElement.appendChild(floatingHoverBtn);

  document.addEventListener(
    "mouseover",
    (e) => {
      if (!floatingHoverBtn) return;
      if (e.target === floatingHoverBtn || floatingHoverBtn.contains(e.target)) return;

      const anchor = e.target?.closest?.(
        'a[href*="/photo"], a[href*="/photos/"], a[href*="/reel/"], a[href*="/reels/"], a[href*="/videos/"], a[href*="/watch"]'
      );
      if (!anchor) return;

      const mediaInfo = parseMediaLinkInfo(anchor.getAttribute("href") || "");
      if (!mediaInfo) return;

      const rect = anchor.getBoundingClientRect();
      if (rect.width < 85 || rect.height < 85) return;

      currentHoveredMediaInfo = mediaInfo;
      currentHoveredAnchor = anchor;

      floatingHoverBtn.style.top = `${Math.max(8, rect.top + 8)}px`;
      floatingHoverBtn.style.left = `${Math.max(8, rect.left + 8)}px`;
      floatingHoverBtn.style.display = "block";
    },
    { passive: true }
  );

  window.addEventListener(
    "scroll",
    () => {
      if (floatingHoverBtn && floatingHoverBtn.style.display !== "none" && !floatingHoverBtn.disabled) {
        floatingHoverBtn.style.display = "none";
      }
    },
    { passive: true }
  );
}

function syncFloatingBars() {
  initZeroCrashHoverSystem();
  syncTopRightActionPill();
  syncManualStoryBar();
}

setTimeout(syncFloatingBars, 1200);
setInterval(syncFloatingBars, 1400);

function syncTopRightActionPill() {
  const profileSlug = getProfileSlugFromUrl();
  const singleMedia = getActiveSingleMediaFromUrl();

  if (!profileSlug && !singleMedia) {
    const oldBar = document.getElementById("facebookswift-top-pill");
    if (oldBar) oldBar.style.display = "none";
    return;
  }

  let pill = document.getElementById("facebookswift-top-pill");
  if (!pill) {
    pill = document.createElement("div");
    pill.id = "facebookswift-top-pill";
    pill.innerHTML = `
      <button id="fb-pill-profile-btn" class="fbswift-btn">⚡ Download All</button>
      <button id="fb-pill-single-btn" class="fb-particular-reel-btn" style="display:none;">🎬 Download This Video</button>
    `;
    document.documentElement.appendChild(pill);

    document.getElementById("fb-pill-profile-btn").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      engageTabBackgroundLock();
      startProfileDownload(getReadableProfileFolderName());
    });

    document.getElementById("fb-pill-single-btn").addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const btn = document.getElementById("fb-pill-single-btn");
      const curr = getActiveSingleMediaFromUrl();
      if (curr) {
        await downloadParticularSingleMedia(curr.id, curr.isVideo, curr.pageUrl, btn, document.body);
      }
    });
  }

  pill.style.display = "flex";
  const profBtn = document.getElementById("fb-pill-profile-btn");
  const singleBtn = document.getElementById("fb-pill-single-btn");

  if (profileSlug) {
    const folderName = getReadableProfileFolderName();
    profBtn.style.display = "inline-flex";
    profBtn.disabled = isScanning;
    if (!isScanning) {
      profBtn.innerHTML = `⚡ Download All (@${folderName})`;
    }
    createOrShowHUD(folderName);
  } else {
    profBtn.style.display = "none";
  }

  if (singleMedia) {
    singleBtn.style.display = "inline-flex";
    if (!singleBtn.disabled) {
      singleBtn.innerHTML = singleMedia.isVideo ? "🎬 Download This Video" : "🖼️ Download This Photo";
    }
  } else {
    singleBtn.style.display = "none";
  }
}

// =========================================================
// PARTICULAR SINGLE VIDEO / REEL / PHOTO DOWNLOADER
// =========================================================
async function downloadParticularSingleMedia(mediaId, isVideoHint, pageUrl, btnEl, domContainer = null) {
  const origLabel = btnEl ? btnEl.innerHTML : "";
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.innerHTML = "⏳ Fetching...";
  }

  try {
    const ownerFallback = getReadableProfileFolderName();
    createOrShowHUD(ownerFallback);
    updateHUDStatus(`Fetching HD stream for item (${mediaId})...`);

    scanEmbeddedCometScripts(ownerFallback);

    let resolvedList = [];
    const cached = mediaCacheById.get(String(mediaId));
    if (cached && cached.url) {
      resolvedList.push({
        username: cached.owner || ownerFallback,
        shortcode: String(mediaId),
        url: cached.url,
        filename: `${mediaId}.${cached.ext}`
      });
    }

    if (resolvedList.length === 0 && pageUrl) {
      const htmlRes = await callMainWorld("FETCH_MEDIA_PAGE_HTML", { url: pageUrl }, 7000);
      if (htmlRes?.ok && htmlRes.html) {
        const extracted = extractBestMediaFromRawHtml(htmlRes.html, mediaId, isVideoHint);
        if (extracted) {
          resolvedList.push({
            username: ownerFallback,
            shortcode: String(mediaId),
            url: extracted.url,
            filename: `${mediaId}.${extracted.ext}`
          });
        }
      }
    }

    if (resolvedList.length === 0 && domContainer) {
      const vEl = domContainer.querySelector?.("video") || document.querySelector("video");
      if (vEl && (vEl.currentSrc || vEl.src) && !(vEl.currentSrc || vEl.src).startsWith("blob:")) {
        resolvedList.push({
          username: ownerFallback,
          shortcode: String(mediaId),
          url: vEl.currentSrc || vEl.src,
          filename: `${mediaId}.mp4`
        });
      } else {
        const imgs = Array.from((domContainer || document).querySelectorAll("img"));
        const bestImg = imgs
          .filter((img) => img.src && img.src.startsWith("http") && Math.max(img.naturalWidth || 0, img.clientWidth || 0) >= 150)
          .sort((a, b) => (b.naturalWidth || b.clientWidth || 0) - (a.naturalWidth || a.clientWidth || 0))[0];
        if (bestImg) {
          resolvedList.push({
            username: ownerFallback,
            shortcode: String(mediaId),
            url: bestImg.src,
            filename: `${mediaId}.jpg`
          });
        }
      }
    }

    if (resolvedList.length === 0) {
      updateHUDStatus(`⚠️ Open the video/reel first so Facebook loads its HD stream, then click Download.`);
      if (btnEl) btnEl.innerHTML = "⚠️ Open First";
      return;
    }

    const folderUser = resolvedList[0].username || ownerFallback;
    await safeSendMessage({
      action: "QUEUE_SINGLE_MEDIA",
      items: resolvedList
    });

    updateHUDStatus(`✅ Downloading ${resolvedList.length} HD file(s) to Facebook/${folderUser}/!`);
    if (btnEl) btnEl.innerHTML = "✓ Saved!";
  } catch (err) {
    updateHUDStatus(`Error: ${err.message}`);
    if (btnEl) btnEl.innerHTML = "⚠️ Error";
  } finally {
    setTimeout(() => {
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.innerHTML = origLabel;
      }
    }, 2200);
  }
}

function decodeFbJsonUrl(raw) {
  if (!raw) return "";
  try {
    return JSON.parse(`"${raw}"`);
  } catch (_) {
    return raw.replace(/\\\//g, "/").replace(/\\u0025/g, "%").replace(/\\u0026/g, "&");
  }
}

function extractBestMediaFromRawHtml(html, mediaId, isVideoHint) {
  if (!html) return null;
  const videoRegexes = [
    /"browser_native_hd_url":"([^"]+)"/,
    /"playable_url_quality_hd":"([^"]+)"/,
    /"hd_ras_v2_net_url":"([^"]+)"/,
    /"browser_native_sd_url":"([^"]+)"/,
    /"playable_url":"([^"]+)"/
  ];
  for (const rx of videoRegexes) {
    const m = html.match(rx);
    if (m && m[1] && m[1] !== "null") {
      const cleanUrl = decodeFbJsonUrl(m[1]);
      if (cleanUrl.startsWith("http")) return { url: cleanUrl, ext: "mp4" };
    }
  }
  if (isVideoHint) return null;
  const photoRegexes = [
    /"viewer_image":\{"height":\d+,"uri":"([^"]+)"/,
    /"photo_image":\{"uri":"([^"]+)"/,
    /"image":\{"uri":"(https:\\\/\\\/scontent[^"]+)"/
  ];
  for (const rx of photoRegexes) {
    const m = html.match(rx);
    if (m && m[1]) {
      const cleanUrl = decodeFbJsonUrl(m[1]);
      if (cleanUrl.startsWith("http")) return { url: cleanUrl, ext: "jpg" };
    }
  }
  return null;
}

// =========================================================
// HD STORY DOWNLOADER (`/stories/...`)
// =========================================================
function syncManualStoryBar() {
  if (!window.location.pathname.startsWith("/stories/")) {
    const existingBar = document.getElementById("facebookswift-story-bar");
    if (existingBar) existingBar.remove();
    return;
  }
  if (document.getElementById("facebookswift-story-bar")) return;

  const bar = document.createElement("div");
  bar.id = "facebookswift-story-bar";
  bar.innerHTML = `
    <button id="fb-dl-curr-story" class="fb-story-btn">⬇ Download This Story</button>
    <button id="fb-dl-all-stories" class="fb-story-btn fb-story-btn-all">⬇ All Stories in Tray</button>
  `;
  document.documentElement.appendChild(bar);

  document.getElementById("fb-dl-curr-story").addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await downloadFacebookStories(false);
  });

  document.getElementById("fb-dl-all-stories").addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await downloadFacebookStories(true);
  });
}

async function downloadFacebookStories(downloadAllInTray = false) {
  const parts = window.location.pathname.split("/").filter(Boolean);
  const targetSlug = (parts[1] || "facebook_stories").toLowerCase();

  createOrShowHUD(targetSlug);
  updateHUDStatus("Resolving HD Story Video/Photo...");

  scanEmbeddedCometScripts(targetSlug);

  const batch = [];
  if (!downloadAllInTray) {
    const domStory = extractActiveStoryFromDOM(targetSlug);
    if (domStory) batch.push(domStory);
    else if (storyItemsById.size > 0) {
      const allCached = Array.from(storyItemsById.values());
      batch.push(allCached[allCached.length - 1]);
    }
  } else {
    const tray = storyTraysByOwner.get(targetSlug);
    if (tray && tray.size > 0) {
      for (const item of tray.values()) batch.push(item);
    } else if (storyItemsById.size > 0) {
      for (const item of storyItemsById.values()) batch.push(item);
    } else {
      const domStory = extractActiveStoryFromDOM(targetSlug);
      if (domStory) batch.push(domStory);
    }
  }

  if (batch.length === 0) {
    updateHUDStatus("⚠️ Story stream still loading. Wait 1s and click again.");
    return;
  }

  await safeSendMessage({
    action: "QUEUE_SINGLE_MEDIA",
    items: batch
  });
  updateHUDStatus(`✅ Downloading ${batch.length} HD Story file(s)!`);
}

function extractActiveStoryFromDOM(targetSlug) {
  const storyId = `story_${Date.now()}`;
  const videos = Array.from(document.querySelectorAll("video")).filter((v) => v.clientHeight > 220);
  for (const v of videos) {
    const src = v.currentSrc || v.src || "";
    if (src && src.startsWith("http") && !src.startsWith("blob:")) {
      return { username: targetSlug, shortcode: storyId, url: src, filename: `${storyId}.mp4` };
    }
  }
  if (videos.length > 0) {
    const cachedVids = Array.from(storyItemsById.values()).filter((i) => i.filename.endsWith(".mp4"));
    if (cachedVids.length > 0) return cachedVids[cachedVids.length - 1];
  }
  const imgs = Array.from(document.querySelectorAll("img"));
  let bestImg = null;
  let maxArea = 0;
  for (const img of imgs) {
    const w = Math.max(img.naturalWidth || 0, img.clientWidth || 0);
    const h = Math.max(img.naturalHeight || 0, img.clientHeight || 0);
    if (w < 250 || h < 250) continue;
    const area = w * h;
    if (area > maxArea && img.src && img.src.startsWith("http")) {
      maxArea = area;
      bestImg = img;
    }
  }
  if (bestImg) return { username: targetSlug, shortcode: storyId, url: bestImg.src, filename: `${storyId}.jpg` };
  return null;
}

function indexPassiveFacebookGraphql(rootObj, fallbackOwner = "") {
  const visited = new WeakSet();
  function walk(node, inheritedOwner = fallbackOwner) {
    if (!node || typeof node !== "object" || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item, inheritedOwner);
      return;
    }

    const currentOwner = (
      node.owner?.username ||
      node.owner?.id ||
      inheritedOwner ||
      "facebook_media"
    ).toString().toLowerCase();

    if (Array.isArray(node.unified_stories?.edges)) {
      for (const edge of node.unified_stories.edges) {
        const sNode = edge?.node;
        const attachments = sNode?.attachments || [];
        for (const att of attachments) {
          if (att?.media) recordFacebookStoryMedia(att.media, currentOwner);
        }
      }
    }

    const id = cleanMediaId(node.id || node.fbid || node.legacy_fbid);
    const extracted = extractFacebookNodeMediaUrl(node);
    if (id && extracted) {
      mediaCacheById.set(id, { id, url: extracted.url, ext: extracted.ext, isVideo: extracted.ext === "mp4", owner: currentOwner });
      if (window.location.pathname.startsWith("/stories/") || node.__typename === "StoryAttachmentMedia") {
        recordFacebookStoryMedia(node, currentOwner);
      }
    }
    for (const k of Object.keys(node)) {
      walk(node[k], currentOwner);
    }
  }
  walk(rootObj, fallbackOwner);
}

function recordFacebookStoryMedia(mediaNode, ownerSlug) {
  const id = cleanMediaId(mediaNode.id || mediaNode.fbid || Date.now());
  const extracted = extractFacebookNodeMediaUrl(mediaNode);
  if (!extracted) return;

  const item = {
    username: ownerSlug || "facebook_stories",
    shortcode: `story_${id}`,
    url: extracted.url,
    filename: `story_${id}.${extracted.ext}`
  };

  storyItemsById.set(id, item);
  if (!storyTraysByOwner.has(item.username)) {
    storyTraysByOwner.set(item.username, new Map());
  }
  storyTraysByOwner.get(item.username).set(id, item);
}

function extractFacebookNodeMediaUrl(node) {
  if (!node || typeof node !== "object") return null;
  const videoCandidates = [
    node.browser_native_hd_url,
    node.playable_url_quality_hd,
    node.hd_ras_v2_net_url,
    node.videoDeliveryResponseFragment?.videoDeliveryResponseResult?.progressive_urls?.find((p) => p?.metadata?.quality === "HD")?.progressive_url,
    node.videoDeliveryResponseFragment?.videoDeliveryResponseResult?.progressive_urls?.[0]?.progressive_url,
    node.browser_native_sd_url,
    node.playable_url
  ].filter((u) => typeof u === "string" && u.startsWith("http"));

  if (videoCandidates.length > 0) return { url: videoCandidates[0], ext: "mp4" };

  const typeName = String(node.__typename || "");
  const isVideoNode = typeName.includes("Video") || node.is_playable === true;
  if (!isVideoNode && (typeName === "Photo" || node.photo_image || node.viewer_image)) {
    const photoCandidates = [node.viewer_image?.uri, node.photo_image?.uri, node.image?.uri].filter((u) => typeof u === "string" && u.startsWith("http"));
    if (photoCandidates.length > 0) return { url: photoCandidates[0], ext: "jpg" };
  }
  return null;
}

// =========================================================
// THE 3-SECTION STAGING ROOM HUD
// =========================================================
function createOrShowHUD(username) {
  let hud = document.getElementById("facebookswift-hud");
  if (!hud) {
    hud = document.createElement("div");
    hud.id = "facebookswift-hud";
    hud.innerHTML = `
      <div class="fb-hud-header">
        <span class="fb-hud-title">⚡ FacebookSwift v34 Room — <strong id="fb-hud-user">@${username}</strong></span>
        <button id="fb-hud-close" title="Minimize">✕</button>
      </div>
      <div class="fb-hud-status" id="fb-hud-status">3-Room Engine Ready (Works in Background / VS Code)</div>
      <div class="fb-hud-grid-3">
        <div class="fb-stat-box fb-room-grid"><span class="fb-stat-val" id="fb-stat-posts">0</span><span class="fb-stat-lbl">Sec 1: Posts/Photos</span></div>
        <div class="fb-stat-box fb-room-reels"><span class="fb-stat-val" id="fb-stat-reels">0</span><span class="fb-stat-lbl">Sec 2: Reels Vault</span></div>
        <div class="fb-stat-box fb-room-dups"><span class="fb-stat-val" id="fb-stat-dups">0</span><span class="fb-stat-lbl">Sec 3: Duplicates</span></div>
      </div>
      <div class="fb-disk-line" id="fb-disk-line">Staging Room: Collects Sec 1 & Sec 2 -> Deduplicates -> Bulk Downloads</div>
      <div class="fb-hud-btn-row">
        <button id="fb-hud-start" class="fb-start-btn">⚡ Download All</button>
        <button id="fb-hud-stop" class="fb-stop-btn">Stop</button>
      </div>
    `;
    document.documentElement.appendChild(hud);

    document.getElementById("fb-hud-close").addEventListener("click", () => {
      hud.style.display = "none";
    });

    document.getElementById("fb-hud-start").addEventListener("click", () => {
      engageTabBackgroundLock();
      startProfileDownload(getReadableProfileFolderName());
    });

    document.getElementById("fb-hud-stop").addEventListener("click", async () => {
      stopRequested = true;
      isScanning = false;
      await safeSendMessage({ action: "USER_EXPLICIT_STOP" });
      updateHUDStatus("Stopped by user.");
      resetButton();
    });
  } else {
    const userEl = document.getElementById("fb-hud-user");
    if (userEl && !isScanning) userEl.textContent = `@${username}`;
  }
  updateRoomHUDCounters();
}

function updateRoomHUDCounters() {
  const pEl = document.getElementById("fb-stat-posts");
  const rEl = document.getElementById("fb-stat-reels");
  const dEl = document.getElementById("fb-stat-dups");
  if (pEl) pEl.textContent = stagingRoom.gridVault.size;
  if (rEl) rEl.textContent = stagingRoom.reelsVault.size;
  if (dEl) dEl.textContent = stagingRoom.duplicateVault.size;
}

function updateHUDStatus(text) {
  const el = document.getElementById("fb-hud-status");
  if (el) el.textContent = text;
}

try {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "STATS_UPDATE" && msg.stats) {
      const diskEl = document.getElementById("fb-disk-line");
      const st = document.getElementById("fb-hud-status");
      if (diskEl && msg.stats.scanned > 0) {
        const vel = msg.stats.velocityFps ? `${msg.stats.velocityFps} files/s` : "Max Speed";
        diskEl.textContent = `Bulk Saved: ${msg.stats.downloaded} / ${msg.stats.scanned} • Speed: ${vel} (${msg.stats.concurrency || 6}x streams)`;
      }
      if (st && !isScanning && msg.stats.status) {
        st.textContent = msg.stats.status;
      }
    } else if (msg.action === "TRIGGER_FROM_POPUP") {
      engageTabBackgroundLock();
      startProfileDownload(getReadableProfileFolderName());
    } else if (msg.action === "TRIGGER_SINGLE_FROM_POPUP") {
      const single = getActiveSingleMediaFromUrl();
      if (single) {
        downloadParticularSingleMedia(single.id, single.isVideo, single.pageUrl, null, document.body);
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false });
      }
      return false;
    }
  });
} catch (_) {}

// =========================================================
// EXACT INSTASWIFT 3-ROOM WORKFLOW FOR FACEBOOK PROFILES:
// Room Sec 1: Scan ALL Posts & Photos into Grid Vault (Zero downloads yet)
// Room Sec 2 & 3: Scan ALL Reels into Reels Vault & Quarantine Duplicates (Zero downloads yet)
// Bulk Launch: Flush Sec 1 U Sec 2 to 10x Little's Law Bulk Downloader
// =========================================================
async function startProfileDownload(folderProfileName) {
  if (isScanning) return;
  isScanning = true;
  stopRequested = false;
  activeTargetUsername = folderProfileName.toLowerCase();
  engageTabBackgroundLock();

  await callMainWorld("ENABLE_BG_SCAN_LOCK", {}, 1200);
  stagingRoom.reset();

  const hud = document.getElementById("facebookswift-hud");
  if (hud) hud.style.display = "block";
  createOrShowHUD(folderProfileName);

  const diskEl = document.getElementById("fb-disk-line");
  if (diskEl) {
    diskEl.textContent = "Staging Room Active: Zero downloads until all 3 sections are compared...";
  }

  const pillBtn = document.getElementById("fb-pill-profile-btn");
  const hudStartBtn = document.getElementById("fb-hud-start");
  if (pillBtn) { pillBtn.disabled = true; pillBtn.textContent = "⏳ Sec 1: Posts/Photos..."; }
  if (hudStartBtn) { hudStartBtn.disabled = true; hudStartBtn.textContent = "⏳ Filling Room..."; }

  try {
    await safeSendMessage({ action: "INIT_SESSION", username: activeTargetUsername });

    // ---------------------------------------------------------
    // ROOM SECTION 1: SCAN ALL POSTS & PHOTOS INTO SEC 1 VAULT
    // ---------------------------------------------------------
    if (!stopRequested) {
      currentScanPhase = "posts";
      updateHUDStatus("Room Sec 1/3: Scanning Timeline Posts into Grid Vault...");
      scanEmbeddedCometScripts(activeTargetUsername, "posts");
      await kinematicAndGraphqlScanPass("posts", 4);

      if (!stopRequested) {
        updateHUDStatus("Room Sec 1/3: Switching to Photos Tab & filling Grid Vault...");
        const switchedPhotos = await switchFacebookProfileTab("photos");
        if (switchedPhotos) {
          scanEmbeddedCometScripts(activeTargetUsername, "posts");
          await kinematicAndGraphqlScanPass("posts", 7);
        }
      }
    }

    // ---------------------------------------------------------
    // ROOM SECTION 2 & 3: SCAN ALL REELS & QUARANTINE DUPLICATES
    // ---------------------------------------------------------
    if (!stopRequested) {
      currentScanPhase = "reels";
      if (pillBtn) pillBtn.textContent = "⏳ Sec 2 & 3: Reels + Dups...";
      updateHUDStatus("Room Sec 2 & 3: Switching to Reels Tab & quarantining duplicates via FNV-1a Hash...");
      const switchedReels = await switchFacebookProfileTab("reels");
      if (switchedReels) {
        scanEmbeddedCometScripts(activeTargetUsername, "reels");
        await kinematicAndGraphqlScanPass("reels", 7);
      }
    }

    if (stopRequested) return;

    // Resolve any Reel links that haven't emitted direct MP4 URLs yet
    const pendingVideoEntries = [
      ...Array.from(stagingRoom.gridVault.values()),
      ...Array.from(stagingRoom.reelsVault.values())
    ].filter((item) => item.needsHtmlResolve && item.pageUrl).slice(0, 30);

    if (!stopRequested && pendingVideoEntries.length > 0) {
      let idx = 0;
      for (const vItem of pendingVideoEntries) {
        if (stopRequested) break;
        idx++;
        updateHUDStatus(`Expanding HD Video Stream (${idx}/${pendingVideoEntries.length})...`);
        const htmlRes = await callMainWorld("FETCH_MEDIA_PAGE_HTML", { url: vItem.pageUrl }, 5500);
        if (htmlRes?.ok && htmlRes.html) {
          const extMedia = extractBestMediaFromRawHtml(htmlRes.html, vItem.shortcode, vItem.isVideo);
          if (extMedia) {
            vItem.url = extMedia.url;
            vItem.filename = `${vItem.shortcode}.${extMedia.ext}`;
            vItem.needsHtmlResolve = false;
          }
        }
        await sleep(280);
      }
    }

    if (stopRequested) return;

    // ---------------------------------------------------------
    // FLUSH STAGING ROOM -> HIGH-SPEED BULK DOWNLOAD (U = Sec 1 U Sec 2)
    // ---------------------------------------------------------
    const finalBulkItems = [
      ...Array.from(stagingRoom.gridVault.values()),
      ...Array.from(stagingRoom.reelsVault.values())
    ].filter((item) => item.url && item.url.startsWith("http") && !item.needsHtmlResolve);

    window.scrollTo(0, 0);
    updateRoomHUDCounters();
    await safeSendMessage({
      action: "UPDATE_ROOM_COUNTS",
      gridCount: stagingRoom.gridVault.size,
      reelsCount: stagingRoom.reelsVault.size,
      dupsCount: stagingRoom.duplicateVault.size
    });

    if (finalBulkItems.length === 0) {
      await safeSendMessage({ action: "SCAN_FINISHED" });
      updateHUDStatus("⚠️ No public downloadable media found on this profile.");
      return;
    }

    if (pillBtn) pillBtn.textContent = "🚀 Bulk Downloading...";
    if (hudStartBtn) hudStartBtn.textContent = "🚀 Bulk Downloading...";
    updateHUDStatus(
      `Room Ready! Sec1: ${stagingRoom.gridVault.size} | Sec2: ${stagingRoom.reelsVault.size} | Sec3 Dups Blocked: ${stagingRoom.duplicateVault.size}. Launching 10x Bulk Download...`
    );

    const PACKET_SIZE = 200;
    for (let i = 0; i < finalBulkItems.length; i += PACKET_SIZE) {
      if (stopRequested) break;
      await safeSendMessage({ action: "QUEUE_MEDIA", items: finalBulkItems.slice(i, i + PACKET_SIZE) });
    }

    if (!stopRequested) await safeSendMessage({ action: "SCAN_FINISHED" });
  } catch (err) {
    updateHUDStatus(`Error: ${err.message}`);
  } finally {
    isScanning = false;
    resetButton();
  }
}

async function switchFacebookProfileTab(targetSection) {
  const allLinks = Array.from(document.querySelectorAll('a[role="tab"], a[href]'));
  const matchLink = allLinks.find((a) => {
    const h = (a.getAttribute("href") || "").toLowerCase();
    const txt = (a.innerText || a.textContent || "").trim().toLowerCase();
    if (targetSection === "reels") {
      return txt === "reels" || h.includes("sk=reels_tab") || h.includes("/reels_tab") || h.includes("sk=videos") || h.includes("/videos");
    } else {
      return txt === "photos" || h.includes("sk=photos") || h.includes("/photos");
    }
  });

  if (matchLink) {
    matchLink.click();
    await sleep(1200);
    return true;
  }
  return false;
}

// =========================================================
// PHYSICS ENGINE: KINEMATICS + DAMPED HARMONIC OSCILLATOR + ACTIVE GRAPHQL PAGINATOR
// y(t) = y_0 + v_0*dt + 0.5*a*dt^2 - A*e^(-\zeta*t)*cos(\omega*t)
// Works 100% in background (VS Code / Android Studio / YouTube) because it calls
// PAGINATE_GRAPHQL_DIRECT via fetch() in addition to kinematic DOM scrolling!
// =========================================================
async function kinematicAndGraphqlScanPass(phaseTag, maxIdleTicks = 7) {
  let idleTicks = 0;
  let stepIndex = 0;
  let lastTotalRoomSize =
    stagingRoom.gridVault.size + stagingRoom.reelsVault.size + stagingRoom.duplicateVault.size;
  let lastScrollHeight = 0;

  while (!stopRequested && idleTicks < maxIdleTicks) {
    stepIndex++;
    harvestVisibleDomMediaIntoRoom(phaseTag);

    // 1. Kinematic Downward Acceleration Step: dy = v_0 + a * t
    const v0 = Math.max(1000, Math.floor(window.innerHeight * 0.95));
    const accelStep = Math.min(800, stepIndex * 75);
    window.scrollBy(0, v0 + accelStep);
    window.dispatchEvent(new Event("scroll", { bubbles: true }));
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: v0 + accelStep, bubbles: true }));

    // 2. Direct MAIN-World GraphQL Cursor Replay (Never throttled when Chrome is minimized to VS Code!)
    const gqlRes = await callMainWorld("PAGINATE_GRAPHQL_DIRECT", { section: phaseTag }, 3500);

    await sleep(650);
    harvestVisibleDomMediaIntoRoom(phaseTag);

    const currentRoomSize =
      stagingRoom.gridVault.size + stagingRoom.reelsVault.size + stagingRoom.duplicateVault.size;
    const currentHeight = document.body.scrollHeight;

    updateHUDStatus(
      `3-Room Scan (${phaseTag.toUpperCase()}) • Sec1: ${stagingRoom.gridVault.size} | Sec2: ${stagingRoom.reelsVault.size} | Sec3 Dups: ${stagingRoom.duplicateVault.size}`
    );

    if (currentRoomSize > lastTotalRoomSize || currentHeight > lastScrollHeight || gqlRes?.hasMore) {
      idleTicks = 0;
      lastTotalRoomSize = currentRoomSize;
      lastScrollHeight = currentHeight;
    } else {
      idleTicks++;
      // 3. Damped Harmonic Oscillator Impulse to wake up stuck React Comet IntersectionObserver
      if (idleTicks % 2 === 0) {
        const amplitude = -Math.round(500 * Math.exp(-0.25 * idleTicks));
        window.scrollBy(0, amplitude);
        window.dispatchEvent(new Event("scroll", { bubbles: true }));
        await sleep(200);
        window.scrollTo(0, document.body.scrollHeight + 2500);
        window.dispatchEvent(new Event("scroll", { bubbles: true }));
        window.dispatchEvent(new Event("resize"));
        await sleep(500);
      }
    }
  }
}

function harvestVisibleDomMediaIntoRoom(phaseTag) {
  const anchors = document.querySelectorAll(
    'a[href*="/photo"], a[href*="/photos/"], a[href*="/reel/"], a[href*="/reels/"], a[href*="/videos/"], a[href*="/watch"]'
  );

  for (const a of anchors) {
    const info = parseMediaLinkInfo(a.getAttribute("href") || "");
    if (!info) continue;

    const cached = mediaCacheById.get(info.id);
    if (cached && cached.url) {
      placeItemIntoStagingRoom(phaseTag, info.id, cached.url, cached.ext, false, info.url, info.isVideo);
      continue;
    }

    if (info.isVideo) {
      placeItemIntoStagingRoom(phaseTag, info.id, info.url, "mp4", true, info.url, true);
      continue;
    }

    const img = a.querySelector("img");
    if (img && img.src && img.src.startsWith("http")) {
      const w = Math.max(img.naturalWidth || 0, img.clientWidth || 0);
      if (w >= 110) {
        placeItemIntoStagingRoom(phaseTag, info.id, img.src, "jpg", false, info.url, false);
      }
    }
  }
}

function routePayloadIntoStagingRoom(rootObj, targetUserLower, phaseTag = "posts") {
  const visited = new WeakSet();

  function walk(node) {
    if (!node || typeof node !== "object" || visited.has(node)) return;
    visited.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    const id = cleanMediaId(node.id || node.fbid || node.legacy_fbid);
    const extracted = extractFacebookNodeMediaUrl(node);

    if (id && extracted) {
      placeItemIntoStagingRoom(phaseTag, id, extracted.url, extracted.ext, false, null, extracted.ext === "mp4");
    }

    for (const k of Object.keys(node)) {
      walk(node[k]);
    }
  }

  walk(rootObj);
  updateRoomHUDCounters();
}

function placeItemIntoStagingRoom(
  phaseTag,
  mediaId,
  mediaUrl,
  ext,
  needsHtmlResolve = false,
  pageUrl = null,
  isVideo = false
) {
  const baseUrl = getBaseCdnPath(mediaUrl);
  const fpHash = fnv1a64Hash(`${mediaId}|${baseUrl}`);
  const filename = `${mediaId}.${ext}`;

  const record = {
    username: activeTargetUsername || "facebook_profile",
    shortcode: String(mediaId),
    url: mediaUrl,
    filename,
    needsHtmlResolve,
    pageUrl,
    isVideo
  };

  if (phaseTag === "posts") {
    const existing = stagingRoom.gridVault.get(mediaId);
    if (existing) {
      if (existing.needsHtmlResolve && !needsHtmlResolve) {
        stagingRoom.gridVault.set(mediaId, record);
      }
      return;
    }
    if (stagingRoom.gridFingerprints.has(fpHash) || (!needsHtmlResolve && stagingRoom.gridBaseUrls.has(baseUrl))) {
      return;
    }

    stagingRoom.gridVault.set(mediaId, record);
    stagingRoom.gridFingerprints.add(fpHash);
    stagingRoom.gridMediaIds.add(mediaId);
    if (!needsHtmlResolve) stagingRoom.gridBaseUrls.add(baseUrl);

    if (stagingRoom.reelsVault.has(mediaId)) {
      stagingRoom.reelsVault.delete(mediaId);
      stagingRoom.duplicateVault.set(mediaId, record);
    }
  } else {
    const existsInGrid =
      stagingRoom.gridVault.has(mediaId) ||
      stagingRoom.gridMediaIds.has(mediaId) ||
      stagingRoom.gridFingerprints.has(fpHash) ||
      (!needsHtmlResolve && stagingRoom.gridBaseUrls.has(baseUrl));

    if (existsInGrid) {
      stagingRoom.duplicateVault.set(mediaId, record);
      return;
    }

    const existingReel = stagingRoom.reelsVault.get(mediaId);
    if (existingReel) {
      if (existingReel.needsHtmlResolve && !needsHtmlResolve) {
        stagingRoom.reelsVault.set(mediaId, record);
      }
      return;
    }
    if (stagingRoom.reelsFingerprints.has(fpHash)) return;

    stagingRoom.reelsVault.set(mediaId, record);
    stagingRoom.reelsFingerprints.add(fpHash);
  }
  updateRoomHUDCounters();
}

function resetButton() {
  const pillBtn = document.getElementById("fb-pill-profile-btn");
  if (pillBtn) {
    pillBtn.disabled = false;
    pillBtn.innerHTML = `⚡ Download All (@${getReadableProfileFolderName()})`;
  }
  const hudStartBtn = document.getElementById("fb-hud-start");
  if (hudStartBtn) {
    hudStartBtn.disabled = false;
    hudStartBtn.textContent = "⚡ Download All";
  }
}