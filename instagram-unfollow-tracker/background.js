/**
 * background.js (Manifest V3 service worker)
 *
 * Orchestrates a scan:
 *   1. Popup asks background to start a scan ("REQUEST_SCAN").
 *   2. Background finds (or opens) a tab on instagram.com and asks
 *      content.js in that tab to do the actual data collection.
 *   3. Background receives progress/results/errors from content.js and
 *      writes them to chrome.storage.local, so the UI reflects the
 *      current state even if the popup is closed and reopened mid-scan
 *      (Chrome closes popups when they lose focus, so the scan itself
 *      must not depend on the popup staying open).
 *   4. On completion, background diffs the new snapshot against the
 *      previously stored one and saves the computed results.
 */

const STORAGE_KEYS = {
  SCAN_STATE: "scanState",
  SNAPSHOT: "snapshot", // last raw followers/following lists
  RESULTS: "results", // computed stats + lists for the UI
};

async function getStorage(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

async function setStorage(items) {
  return new Promise((resolve) => chrome.storage.local.set(items, resolve));
}

async function setScanState(state) {
  await setStorage({ [STORAGE_KEYS.SCAN_STATE]: state });
}

function toMap(list) {
  const map = new Map();
  for (const item of list) map.set(item.pk, item);
  return map;
}

/**
 * Computes all derived lists from a current snapshot and (optionally)
 * a previous snapshot.
 *
 * - notFollowingBack: people the user follows who do not follow the user (current state only).
 * - mutuals: people who follow the user and whom the user follows (current state only).
 * - newFollowers: people present in current followers but NOT present in the
 *   previous followers snapshot. Only computed when a previous snapshot exists.
 * - unfollowers: people present in the PREVIOUS followers snapshot who are
 *   NOT present in the current followers snapshot. This is the only condition
 *   that counts as an "unfollower" — someone who was never a follower before
 *   is never classified this way, no matter how the current lists look.
 */
function computeResults(current, previous) {
  const currentFollowerIds = toMap(current.followers);

  const notFollowingBackList = current.following.filter((u) => !currentFollowerIds.has(u.pk));
  const mutualsList = current.following.filter((u) => currentFollowerIds.has(u.pk));

  let newFollowersList = [];
  let unfollowersList = [];
  let hasPrevious = false;

  if (previous && Array.isArray(previous.followers)) {
    hasPrevious = true;
    const previousFollowerIds = toMap(previous.followers);

    newFollowersList = current.followers.filter((u) => !previousFollowerIds.has(u.pk));
    unfollowersList = previous.followers.filter((u) => !currentFollowerIds.has(u.pk));
  }

  return {
    hasPrevious,
    generatedAt: Date.now(),
    username: current.username || null,
    stats: {
      followers: current.followers.length,
      following: current.following.length,
      mutuals: mutualsList.length,
      notFollowingBack: notFollowingBackList.length,
      newFollowers: newFollowersList.length,
      unfollowers: unfollowersList.length,
    },
    lists: {
      followers: current.followers,
      following: current.following,
      mutuals: mutualsList,
      notFollowingBack: notFollowingBackList,
      newFollowers: newFollowersList,
      unfollowers: unfollowersList,
    },
  };
}

async function findOrCreateInstagramTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.instagram.com/*" });
  if (tabs.length > 0) {
    // Prefer a tab that's already fully loaded.
    const loaded = tabs.find((t) => t.status === "complete");
    return loaded || tabs[0];
  }

  const created = await chrome.tabs.create({ url: "https://www.instagram.com/", active: false });
  await new Promise((resolve) => {
    function listener(tabId, changeInfo) {
      if (tabId === created.id && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
  return created;
}

async function startScan() {
  await setScanState({ status: "running", stage: "connecting", startedAt: Date.now(), error: null });

  let tab;
  try {
    tab = await findOrCreateInstagramTab();
  } catch (err) {
    await setScanState({
      status: "error",
      stage: null,
      error: "Could not open an Instagram tab. Check your extension's permissions.",
    });
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "START_SCAN" });
  } catch (err) {
    // Most common cause: the content script hasn't attached yet because the
    // tab just navigated. Reload and retry once.
    try {
      await chrome.tabs.reload(tab.id);
      await new Promise((resolve) => {
        function listener(tabId, changeInfo) {
          if (tabId === tab.id && changeInfo.status === "complete") {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        }
        chrome.tabs.onUpdated.addListener(listener);
      });
      await chrome.tabs.sendMessage(tab.id, { type: "START_SCAN" });
    } catch (retryErr) {
      await setScanState({
        status: "error",
        stage: null,
        error: "Could not communicate with the Instagram tab. Try opening instagram.com manually, then check again.",
      });
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "REQUEST_SCAN") {
    startScan();
    sendResponse({ started: true });
    return true;
  }

  if (message?.type === "SCAN_PROGRESS") {
    setScanState({
      status: "running",
      stage: message.stage,
      detail: message.detail || null,
      error: null,
    });
    return false;
  }

  if (message?.type === "SCAN_COMPLETE") {
    (async () => {
      const stored = await getStorage([STORAGE_KEYS.SNAPSHOT]);
      const previousSnapshot = stored[STORAGE_KEYS.SNAPSHOT] || null;
      const current = message.result;

      const results = computeResults(current, previousSnapshot);

      await setStorage({
        [STORAGE_KEYS.SNAPSHOT]: current,
        [STORAGE_KEYS.RESULTS]: results,
      });
      await setScanState({
        status: "done",
        stage: null,
        error: null,
        completedAt: Date.now(),
      });
    })();
    return false;
  }

  if (message?.type === "SCAN_ERROR") {
    setScanState({
      status: "error",
      stage: null,
      error: message.message || "An unknown error occurred.",
      code: message.code || "UNKNOWN",
    });
    return false;
  }

  return undefined;
});

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await getStorage([STORAGE_KEYS.SCAN_STATE]);
  if (!stored[STORAGE_KEYS.SCAN_STATE]) {
    await setScanState({ status: "idle", stage: null, error: null });
  }
});
