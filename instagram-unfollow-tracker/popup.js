const STORAGE_KEYS = {
  SCAN_STATE: "scanState",
  RESULTS: "results",
};

const STAGE_LABELS = {
  connecting: "Connecting to Instagram…",
  followers: "Loading followers…",
  following: "Loading following…",
  comparing: "Comparing accounts…",
  updating: "Updating results…",
};

const TAB_CONFIG = {
  overview: { label: "Overview", listKey: null },
  notFollowingBack: { label: "Not Following Back", listKey: "notFollowingBack" },
  unfollowers: { label: "Unfollowers", listKey: "unfollowers" },
  newFollowers: { label: "New Followers", listKey: "newFollowers" },
  mutuals: { label: "Mutuals", listKey: "mutuals" },
};

let activeTab = "overview";
let searchTerm = "";
let latestResults = null;
let latestScanState = { status: "idle" };

const els = {
  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText"),
  refreshBtn: document.getElementById("refreshBtn"),
  refreshLabel: document.getElementById("refreshLabel"),
  progressBar: document.getElementById("progressBar"),
  progressText: document.getElementById("progressText"),
  lastChecked: document.getElementById("lastChecked"),
  statFollowers: document.getElementById("statFollowers"),
  statFollowing: document.getElementById("statFollowing"),
  statMutuals: document.getElementById("statMutuals"),
  statNotFollowingBack: document.getElementById("statNotFollowingBack"),
  statNewFollowers: document.getElementById("statNewFollowers"),
  statUnfollowers: document.getElementById("statUnfollowers"),
  tabs: document.getElementById("tabs"),
  searchInput: document.getElementById("searchInput"),
  listContainer: document.getElementById("listContainer"),
};

function formatTimestamp(ts) {
  if (!ts) return "never";
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function setConnectionStatus(state) {
  els.statusDot.classList.remove("status-connected", "status-disconnected", "status-unknown");
  if (state === "connected") {
    els.statusDot.classList.add("status-connected");
    els.statusText.textContent = "Connected";
  } else if (state === "disconnected") {
    els.statusDot.classList.add("status-disconnected");
    els.statusText.textContent = "Not connected";
  } else {
    els.statusDot.classList.add("status-unknown");
    els.statusText.textContent = "Checking status…";
  }
}

async function checkConnectionStatus() {
  try {
    const tabs = await chrome.tabs.query({ url: "https://www.instagram.com/*" });
    if (tabs.length === 0) {
      setConnectionStatus("disconnected");
      return;
    }
    const tab = tabs.find((t) => t.status === "complete") || tabs[0];
    chrome.tabs.sendMessage(tab.id, { type: "CHECK_STATUS" }, (response) => {
      if (chrome.runtime.lastError || !response) {
        setConnectionStatus("disconnected");
        return;
      }
      setConnectionStatus(response.loggedIn ? "connected" : "disconnected");
    });
  } catch (err) {
    setConnectionStatus("disconnected");
  }
}

function renderScanState() {
  const isRunning = latestScanState.status === "running";
  els.refreshBtn.disabled = isRunning;
  els.refreshBtn.classList.toggle("spinning", isRunning);
  els.progressBar.classList.toggle("hidden", !isRunning);

  if (isRunning) {
    const stage = latestScanState.stage || "connecting";
    let text = STAGE_LABELS[stage] || "Working…";
    const loaded = latestScanState.detail?.loaded;
    if ((stage === "followers" || stage === "following") && typeof loaded === "number" && loaded > 0) {
      text += ` (${loaded} so far)`;
    }
    els.progressText.textContent = text;
    els.refreshLabel.textContent = "Checking…";
  } else {
    els.refreshLabel.textContent = "Check now";
  }

  if (latestScanState.status === "error" && latestScanState.error) {
    renderErrorBanner(latestScanState.error);
  }
}

function renderErrorBanner(message) {
  const existing = document.querySelector(".error-state");
  if (existing) existing.remove();
  const banner = document.createElement("div");
  banner.className = "error-state";
  banner.textContent = message;
  els.listContainer.parentElement.insertBefore(banner, els.listContainer);
}

function clearErrorBanner() {
  const existing = document.querySelector(".error-state");
  if (existing) existing.remove();
}

function renderStats() {
  if (!latestResults) {
    els.statFollowers.textContent = "–";
    els.statFollowing.textContent = "–";
    els.statMutuals.textContent = "–";
    els.statNotFollowingBack.textContent = "–";
    els.statNewFollowers.textContent = "–";
    els.statUnfollowers.textContent = "–";
    els.lastChecked.textContent = "never";
    return;
  }

  const s = latestResults.stats;
  els.statFollowers.textContent = s.followers;
  els.statFollowing.textContent = s.following;
  els.statMutuals.textContent = s.mutuals;
  els.statNotFollowingBack.textContent = s.notFollowingBack;
  els.statNewFollowers.textContent = latestResults.hasPrevious ? s.newFollowers : "–";
  els.statUnfollowers.textContent = latestResults.hasPrevious ? s.unfollowers : "–";
  els.lastChecked.textContent = formatTimestamp(latestResults.generatedAt);
}

function makeUserRow(user) {
  const row = document.createElement("div");
  row.className = "user-row";

  let avatar;
  if (user.profilePicUrl) {
    avatar = document.createElement("img");
    avatar.className = "user-avatar";
    avatar.src = user.profilePicUrl;
    avatar.alt = user.username;
    avatar.referrerPolicy = "no-referrer";
    avatar.onerror = () => {
      avatar.replaceWith(makePlaceholderAvatar(user.username));
    };
  } else {
    avatar = makePlaceholderAvatar(user.username);
  }

  const info = document.createElement("div");
  info.className = "user-info";

  const uname = document.createElement("div");
  uname.className = "user-username";
  uname.textContent = `@${user.username}`;

  const status = document.createElement("div");
  status.className = "user-status";
  status.textContent = user.fullName || (user.isPrivate ? "Private account" : "");

  info.appendChild(uname);
  info.appendChild(status);

  const link = document.createElement("a");
  link.className = "user-link";
  link.href = `https://www.instagram.com/${user.username}/`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "View";

  row.appendChild(avatar);
  row.appendChild(info);
  row.appendChild(link);
  return row;
}

function makePlaceholderAvatar(username) {
  const div = document.createElement("div");
  div.className = "user-avatar placeholder";
  div.textContent = (username || "?").charAt(0).toUpperCase();
  return div;
}

function emptyStateFor(tabKey) {
  const el = document.createElement("div");
  el.className = "empty-state";

  if (!latestResults) {
    el.innerHTML = `<span class="emoji">👋</span>Run your first check to start tracking changes.`;
    return el;
  }

  if (tabKey === "notFollowingBack") {
    el.innerHTML = `<span class="emoji">✨</span>Everyone you follow follows you back ✨`;
  } else if (tabKey === "unfollowers") {
    el.innerHTML = latestResults.hasPrevious
      ? `<span class="emoji">✅</span>No unfollowers detected`
      : `<span class="emoji">👋</span>Run your first check to start tracking changes.`;
  } else if (tabKey === "newFollowers") {
    el.innerHTML = latestResults.hasPrevious
      ? `<span class="emoji">🌱</span>No new followers since your last check`
      : `<span class="emoji">👋</span>Run your first check to start tracking changes.`;
  } else if (tabKey === "mutuals") {
    el.innerHTML = `<span class="emoji">🤝</span>No mutual follows yet`;
  } else {
    el.innerHTML = `<span class="emoji">📭</span>Nothing to show yet`;
  }
  return el;
}

function renderOverview() {
  const container = document.createDocumentFragment();

  if (!latestResults) {
    els.listContainer.replaceChildren(emptyStateFor("overview"));
    return;
  }

  const sections = [
    { key: "unfollowers", title: "Recent unfollowers" },
    { key: "newFollowers", title: "Recent new followers" },
    { key: "notFollowingBack", title: "Not following you back" },
  ];

  let anyRendered = false;

  for (const section of sections) {
    const list = latestResults.lists[section.key].slice(0, 5);
    if (list.length === 0) continue;
    anyRendered = true;

    const heading = document.createElement("div");
    heading.className = "user-status";
    heading.style.margin = "10px 4px 4px";
    heading.style.fontWeight = "700";
    heading.style.textTransform = "uppercase";
    heading.style.fontSize = "10px";
    heading.style.color = "var(--text-tertiary)";
    heading.textContent = section.title;
    container.appendChild(heading);

    for (const user of list) {
      container.appendChild(makeUserRow(user));
    }
  }

  if (!anyRendered) {
    els.listContainer.replaceChildren(emptyStateFor("overview"));
    return;
  }

  els.listContainer.replaceChildren(container);
}

function renderTabList(tabKey) {
  if (tabKey === "overview") {
    renderOverview();
    return;
  }

  const listKey = TAB_CONFIG[tabKey].listKey;
  const list = latestResults ? latestResults.lists[listKey] : [];
  const filtered = searchTerm
    ? list.filter((u) => u.username.toLowerCase().includes(searchTerm))
    : list;

  if (filtered.length === 0) {
    els.listContainer.replaceChildren(emptyStateFor(tabKey));
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const user of filtered) {
    fragment.appendChild(makeUserRow(user));
  }
  els.listContainer.replaceChildren(fragment);
}

function renderAll() {
  clearErrorBanner();
  renderStats();
  renderScanState();
  renderTabList(activeTab);
}

function setActiveTab(tabKey) {
  activeTab = tabKey;
  for (const btn of els.tabs.querySelectorAll(".tab")) {
    btn.classList.toggle("active", btn.dataset.tab === tabKey);
  }
  renderTabList(activeTab);
}

async function loadFromStorage() {
  const data = await new Promise((resolve) =>
    chrome.storage.local.get([STORAGE_KEYS.SCAN_STATE, STORAGE_KEYS.RESULTS], resolve)
  );
  latestScanState = data[STORAGE_KEYS.SCAN_STATE] || { status: "idle" };
  latestResults = data[STORAGE_KEYS.RESULTS] || null;
  renderAll();
}

function attachEventListeners() {
  els.refreshBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "REQUEST_SCAN" });
  });

  els.tabs.addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (!btn) return;
    setActiveTab(btn.dataset.tab);
  });

  els.searchInput.addEventListener("input", (e) => {
    searchTerm = e.target.value.trim().toLowerCase();
    renderTabList(activeTab);
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes[STORAGE_KEYS.SCAN_STATE]) {
      latestScanState = changes[STORAGE_KEYS.SCAN_STATE].newValue || { status: "idle" };
    }
    if (changes[STORAGE_KEYS.RESULTS]) {
      latestResults = changes[STORAGE_KEYS.RESULTS].newValue || null;
    }
    renderAll();

    if (changes[STORAGE_KEYS.RESULTS]) {
      checkConnectionStatus();
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  attachEventListeners();
  await loadFromStorage();
  checkConnectionStatus();
});
