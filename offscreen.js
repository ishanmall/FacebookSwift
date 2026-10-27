try {
  if (navigator.locks && navigator.locks.request) {
    navigator.locks.request("facebookswift_v34_permanent_lock", () => new Promise(() => {}));
  }
} catch (_) {}

let audioCtx = null;
function keepAudioAwake() {
  try {
    if (audioCtx && audioCtx.state === "running") return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx = new Ctx();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    gain.gain.value = 0.00001;
    osc.frequency.value = 1;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
  } catch (_) {}
}
keepAudioAwake();

let port = null;
function connectPort() {
  try {
    port = chrome.runtime.connect({ name: "facebookswift_offscreen_port" });
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connectPort, 200);
    });
  } catch (_) {}
}
connectPort();

setInterval(() => {
  keepAudioAwake();
  try {
    if (port) {
      port.postMessage({ type: "HEARTBEAT", ts: Date.now() });
    } else {
      connectPort();
    }
    chrome.runtime.sendMessage({ action: "OFFSCREEN_HEARTBEAT" }).catch(() => {});
  } catch (_) {
    connectPort();
  }
}, 250);