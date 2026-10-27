function refreshPopupStats() {
  chrome.runtime.sendMessage({ action: "GET_STATS" }, (stats) => {
    if (chrome.runtime.lastError || !stats) return;
    document.getElementById("p-status").textContent = `Status: ${stats.status}` + (stats.username ? ` (@${stats.username})` : "");
    document.getElementById("p-grid").textContent = stats.gridCount || 0;
    document.getElementById("p-reels").textContent = stats.reelsCount || 0;
    document.getElementById("p-dups").textContent = stats.dupsCount || 0;
    document.getElementById("p-scanned").textContent = stats.scanned || 0;
    document.getElementById("p-downloaded").textContent = stats.downloaded || 0;
    document.getElementById("p-speed").textContent = (stats.velocityFps || 0) + "/s";
  });
}
document.getElementById("p-single-trigger").addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) chrome.tabs.sendMessage(tabs[0].id, { action: "TRIGGER_SINGLE_FROM_POPUP" }, () => window.close());
  });
});
document.getElementById("p-trigger").addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) chrome.tabs.sendMessage(tabs[0].id, { action: "TRIGGER_FROM_POPUP" }, () => window.close());
  });
});
refreshPopupStats();
setInterval(refreshPopupStats, 600);