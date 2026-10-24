// Only an explicit, confirmed sign-out is broadcast. Receiving this signal may
// clear a view, but must never fetch or grant access to private data.
export const SESSION_CLEARED = "shelf:session-cleared";
const channelName = "shelf-session-state-v1";
let channel;
function getChannel() {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined")
    return null;
  if (!channel) {
    channel = new BroadcastChannel(channelName);
    channel.addEventListener("message", (event) => {
      if (event.data === "signed-out")
        window.dispatchEvent(new Event(SESSION_CLEARED));
    });
  }
  return channel;
}
export function clearPrivateSession({ broadcast = false } = {}) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(SESSION_CLEARED));
  if (broadcast) getChannel()?.postMessage("signed-out");
}
export function privateView({
  window: host = window,
  document: doc = typeof document === "undefined" ? null : document,
  clear = () => {},
  checkSession,
} = {}) {
  getChannel();
  let active = true;
  const controller = new AbortController();
  let authenticated = false;
  let sessionGeneration = 0;
  const cleaners = new Set();
  const close = () => {
    if (!active) return;
    active = false;
    controller.abort();
    sessionGeneration++;
    host.removeEventListener(SESSION_CLEARED, close);
    host.removeEventListener("pagehide", close);
    host.removeEventListener("pageshow", recheck);
    doc?.removeEventListener("visibilitychange", visible);
    cleaners.forEach((cleanup) => {
      try {
        cleanup();
      } catch {}
    });
    cleaners.clear();
    clear();
  };
  async function recheck() {
    if (!active || !authenticated || !checkSession) return;
    const generation = ++sessionGeneration;
    try {
      const state = await checkSession();
      if (
        active &&
        generation === sessionGeneration &&
        authenticated &&
        state?.authenticated === false
      )
        close();
    } catch (error) {
      if (
        active &&
        generation === sessionGeneration &&
        authenticated &&
        error?.status === 401
      )
        close();
      // Network failure is not proof of logout. Never fetch content or AI here.
    }
  }
  function visible() {
    if (doc?.visibilityState === "visible") void recheck();
  }
  host.addEventListener("pageshow", recheck);
  doc?.addEventListener("visibilitychange", visible);
  host.addEventListener(SESSION_CLEARED, close);
  host.addEventListener("pagehide", close);
  return {
    signal: controller.signal,
    setAuthenticated(value) {
      authenticated = value === true;
      sessionGeneration++;
    },
    get active() {
      return active;
    },
    assert() {
      if (!active)
        throw Object.assign(new Error("页面会话已结束，请重新载入。"), {
          code: "view_closed",
        });
    },
    cleanup(callback) {
      if (active) cleaners.add(callback);
      else callback();
    },
    close,
  };
}
