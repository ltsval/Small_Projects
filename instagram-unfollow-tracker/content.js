/**
 * content.js
 *
 * Runs in the context of https://www.instagram.com/*.
 * Responsible for:
 *   - Reading the logged-in user's id/username from the page's own cookies
 *     (the same cookies Instagram's own web app uses).
 *   - Calling Instagram's internal web API (the same endpoints the
 *     instagram.com website itself calls when you open the
 *     "Followers" / "Following" dialog) to page through the full lists.
 *   - Reporting progress and results back to the background service worker.
 *
 * IMPORTANT: This does NOT use a private/undocumented "hacking" API.
 * It calls the exact same JSON endpoints your browser calls when you,
 * as a logged-in user, open your own followers/following dialog on
 * instagram.com and scroll. No credentials are read or transmitted
 * beyond the session cookies your browser already sends to
 * instagram.com on every request to that site.
 */

const IG_APP_ID = "936619743392459"; // Public app id instagram.com's own web client sends on every API call.
const PAGE_SIZE = 50;
const REQUEST_DELAY_MS = 1200; // Spacing between paged requests to stay well under Instagram's rate limits.
const MAX_RETRIES_ON_RATE_LIMIT = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCookie(name) {
  const match = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return match ? decodeURIComponent(match[1]) : null;
}

function getCsrfToken() {
  return getCookie("csrftoken");
}

function getLoggedInUserId() {
  return getCookie("ds_user_id");
}

class ScanError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code; // 'LOGIN_REQUIRED' | 'RATE_LIMITED' | 'NETWORK' | 'UNKNOWN'
  }
}

async function igFetch(url) {
  const csrfToken = getCsrfToken();
  const response = await fetch(url, {
    method: "GET",
    credentials: "include", // Sends the browser's existing Instagram session cookies.
    headers: {
      "x-ig-app-id": IG_APP_ID,
      "x-csrftoken": csrfToken || "",
      "x-requested-with": "XMLHttpRequest",
      accept: "*/*",
    },
  });

  if (response.status === 401 || response.status === 403) {
    throw new ScanError(
      "Instagram says you are not logged in. Please log into instagram.com in this browser and try again.",
      "LOGIN_REQUIRED"
    );
  }

  if (response.status === 429) {
    throw new ScanError(
      "Instagram is rate-limiting this browser session. Please wait a few minutes before checking again.",
      "RATE_LIMITED"
    );
  }

  if (!response.ok) {
    throw new ScanError(`Instagram returned an unexpected error (HTTP ${response.status}).`, "UNKNOWN");
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    throw new ScanError("Instagram returned a response that could not be parsed. Its API may have changed.", "UNKNOWN");
  }

  return data;
}

async function igFetchWithRetry(url) {
  let attempt = 0;
  while (true) {
    try {
      return await igFetch(url);
    } catch (err) {
      if (err.code === "RATE_LIMITED" && attempt < MAX_RETRIES_ON_RATE_LIMIT) {
        attempt += 1;
        await sleep(5000 * attempt);
        continue;
      }
      throw err;
    }
  }
}

function reportProgress(stage, detail) {
  chrome.runtime.sendMessage({
    type: "SCAN_PROGRESS",
    stage,
    detail: detail || null,
  });
}

/**
 * Pages through /api/v1/friendships/<id>/followers/ or /following/,
 * following Instagram's own cursor-based pagination (max_id / next_max_id),
 * exactly the way instagram.com's own JS does when you scroll the dialog.
 */
async function fetchFriendshipList(userId, kind, onPage) {
  const results = [];
  let maxId = "";
  let hasMore = true;
  let page = 0;

  while (hasMore) {
    const params = new URLSearchParams({ count: String(PAGE_SIZE) });
    if (maxId) params.set("max_id", maxId);

    const url = `https://www.instagram.com/api/v1/friendships/${userId}/${kind}/?${params.toString()}`;
    const data = await igFetchWithRetry(url);

    const users = Array.isArray(data.users) ? data.users : [];
    for (const u of users) {
      results.push({
        pk: String(u.pk ?? u.id ?? u.username),
        username: u.username,
        fullName: u.full_name || "",
        profilePicUrl: u.profile_pic_url || "",
        isPrivate: !!u.is_private,
      });
    }

    page += 1;
    if (typeof onPage === "function") onPage(results.length, page);

    maxId = data.next_max_id || "";
    hasMore = Boolean(maxId) && users.length > 0;

    if (hasMore) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  return results;
}

async function fetchCurrentUsername(userId) {
  try {
    const data = await igFetchWithRetry(
      `https://www.instagram.com/api/v1/users/${userId}/info/`
    );
    return data?.user?.username || null;
  } catch (err) {
    // Non-fatal: the scan can still proceed without the display name.
    return null;
  }
}

async function runScan() {
  const userId = getLoggedInUserId();
  if (!userId) {
    throw new ScanError(
      "Could not detect a logged-in Instagram account in this tab. Please log into instagram.com and try again.",
      "LOGIN_REQUIRED"
    );
  }

  reportProgress("connecting");
  const username = await fetchCurrentUsername(userId);

  reportProgress("followers", { loaded: 0 });
  const followers = await fetchFriendshipList(userId, "followers", (loaded) => {
    reportProgress("followers", { loaded });
  });

  reportProgress("following", { loaded: 0 });
  const following = await fetchFriendshipList(userId, "following", (loaded) => {
    reportProgress("following", { loaded });
  });

  reportProgress("comparing");

  return {
    userId,
    username,
    followers,
    following,
    fetchedAt: Date.now(),
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "CHECK_STATUS") {
    // Cheap, local-only check (no network request): just confirms whether
    // this tab currently has an authenticated Instagram session cookie.
    const userId = getLoggedInUserId();
    sendResponse({ loggedIn: Boolean(userId) });
    return true;
  }

  if (message?.type !== "START_SCAN") return undefined;

  runScan()
    .then((result) => {
      chrome.runtime.sendMessage({ type: "SCAN_COMPLETE", result });
    })
    .catch((err) => {
      chrome.runtime.sendMessage({
        type: "SCAN_ERROR",
        code: err.code || "UNKNOWN",
        message: err.message || "An unknown error occurred while scanning Instagram.",
      });
    });

  // No synchronous response needed; results are pushed via runtime messages.
  return false;
});
