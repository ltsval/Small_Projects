# Instagram Unfollow Tracker

A Chrome extension (Manifest V3) that uses your own logged-in Instagram Web
session to show you:

- **Followers**, **Following**, **Mutuals**
- **Not Following Back** — accounts you follow that don't follow you
- **New Followers** and **Unfollowers**, detected by comparing each check
  against the previous one

Everything runs locally in your browser. No password is ever requested, no
credentials are stored, and no data leaves your machine.

---

## How it works (architecture)

```
popup.html/js  ── "check now" ──▶  background.js (service worker)
                                          │
                                          │ finds/opens an instagram.com tab
                                          ▼
                                   content.js (runs on instagram.com)
                                          │
                                          │ calls Instagram's own web API
                                          │ endpoints using your existing
                                          │ session cookies
                                          ▼
                              followers/following lists + progress
                                          │
                                          ▼
                          background.js diffs vs. previous snapshot,
                          saves results to chrome.storage.local
                                          │
                                          ▼
                     popup.js reads chrome.storage and renders the UI,
                     live-updating via chrome.storage.onChanged
```

**Why the scan logic lives in the background script, not the popup:**
Chrome closes extension popups whenever they lose focus (e.g. you click
another window). A follower scan on a large account can take a while because
of the pacing needed to avoid rate limits, so the popup cannot be the thing
"running" the scan — it would get killed. Instead:

1. The popup only *triggers* a scan (`REQUEST_SCAN` message) and then reads
   whatever is in `chrome.storage.local`.
2. The **background service worker** finds or opens an `instagram.com` tab and
   asks the **content script** in that tab to do the actual work.
3. The **content script** calls Instagram's own internal web API — the exact
   JSON endpoints `instagram.com` itself calls when you open your Followers /
   Following dialog and scroll — using `fetch()` with `credentials: "include"`
   so your existing session cookies are sent, exactly as they would be for any
   normal page request.
4. Progress and final results are sent back to the background worker, which
   computes the diff against the last saved snapshot and writes everything to
   `chrome.storage.local`.
5. The popup listens for `chrome.storage.onChanged` and re-renders live,
   whether it was open the whole time or just reopened after the scan
   finished.

### Follower/following data collection strategy

Rather than scraping the visual DOM of the followers/following modal (which
is fragile — Instagram's class names are obfuscated and change often, and the
modal virtualizes/unmounts rows as you scroll, making a pure DOM-scrape
approach unreliable for large lists), this extension calls Instagram's
**internal JSON API directly**:

```
GET https://www.instagram.com/api/v1/friendships/<user_id>/followers/?count=50&max_id=...
GET https://www.instagram.com/api/v1/friendships/<user_id>/following/?count=50&max_id=...
```

These are the same endpoints the instagram.com web app calls internally. The
extension pages through them using Instagram's own cursor (`next_max_id`),
which is the same mechanism the site uses when you scroll the dialog — it's
just driven programmatically instead of by scroll events. This is
**significantly more reliable** than trying to read rendered list items out of
the DOM, but it is still calling a private/undocumented API, so it can break
if Instagram changes these endpoints or their response shape (see
Limitations below).

### Unfollower detection logic

This is intentionally strict, per the requirement that someone should never
be mislabeled as an "unfollower" just because they don't follow you back:

| | Was in **previous** followers snapshot | Was **not** in previous followers snapshot |
|---|---|---|
| **Is in current** followers | — (still a follower) | Counted as **New Follower** |
| **Is not in current** followers | Counted as **Unfollower** | Never counted as anything — they simply never followed you, so there's nothing to detect |

`notFollowingBack` and `mutuals` are computed purely from the **current**
snapshot (who you follow vs. who follows you right now) and don't depend on
history at all.

On your very first-ever scan there is no previous snapshot, so New
Followers/Unfollowers show as "Run your first check to start tracking
changes." instead of `0`, since `0` would misleadingly imply "no changes"
when really there's nothing to compare against yet.

---

## Project structure

```
instagram-unfollow-tracker/
├── manifest.json      Manifest V3 config
├── popup.html          Popup markup
├── popup.css           Popup styling
├── popup.js            Popup logic (rendering, tabs, search, live updates)
├── content.js          Runs on instagram.com; fetches follower/following data
├── background.js       Service worker; orchestrates scans, diffs, storage
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

No build step is required — this is plain JavaScript/HTML/CSS.

---

## Installation

1. Download/copy this folder (`instagram-unfollow-tracker/`) somewhere on
   your computer.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked**.
5. Select the `instagram-unfollow-tracker` folder.
6. The extension icon should appear in your toolbar. Pin it for easy access.
7. Log into **instagram.com** in a normal Chrome tab if you aren't already.
8. Click the extension icon, then click **Check now**.

---

## Testing checklist

- [ ] With no prior scan, popup shows "Run your first check to start
      tracking changes." in each list tab, and stat cards show `–` for
      New Followers / Unfollowers.
- [ ] Clicking **Check now** while not logged into Instagram shows a clear
      error state (not a silent failure or a fake "0 followers" result).
- [ ] Clicking **Check now** while logged in shows progress text updating
      through "Connecting…", "Loading followers…", "Loading following…",
      "Comparing accounts…", and the popup UI stays responsive throughout
      (you can still switch tabs while it's spinning).
- [ ] After a completed scan: Followers/Following/Mutuals/Not Following Back
      stat cards show real numbers; New Followers/Unfollowers show `0`
      (a second scan run right after the first, with no real-world changes,
      should show 0 for both).
- [ ] Closing the popup mid-scan and reopening it later shows the scan
      either still in progress or completed — it does not restart or lose
      progress just because the popup was closed.
- [ ] The **Not Following Back** tab lists only accounts you follow that
      aren't in your followers list.
- [ ] The **Mutuals** tab lists only accounts that are in both lists.
- [ ] Manually unfollowing an account on Instagram, then running two more
      checks (one to capture them as a current follower/following-back
      relationship if applicable, one after the unfollow), correctly shows
      them under **Unfollowers** — and *not* under Unfollowers before you've
      ever had them in a previous snapshot.
- [ ] The search box filters the currently active tab's list instantly, with
      no extra network activity.
- [ ] "Last checked" timestamp updates after every successful scan.
- [ ] Works with accounts that have very large (1,000+) follower/following
      counts without the popup freezing (progress count updates as pages
      load).
- [ ] Status indicator shows "● Connected" when an instagram.com tab with an
      active session is open, and "● Not connected" otherwise.

---

## Known Instagram limitations

- **This uses a private, undocumented Instagram API.** Instagram does not
  publish or support these endpoints for third-party use. They can change
  their response shape, rate limits, or remove/replace the endpoints at any
  time without notice, which would break this extension until it's updated.
- **Rate limiting.** Instagram aggressively rate-limits automated-looking
  request patterns. The extension paces requests (~1.2s apart, with backoff
  and retries on HTTP 429) to reduce this risk, but on very large accounts
  (tens of thousands of followers) a full scan can still take a long time,
  and Instagram may still temporarily throttle or block requests. If that
  happens, the extension surfaces a clear "rate limited" error rather than
  reporting incomplete data as if it were complete.
- **Login requirement.** If you're logged out, or Instagram invalidates your
  session (e.g. via a security checkpoint), the scan will fail with a
  "login required" message rather than silently returning empty lists.
- **Private/limited accounts.** The lists returned reflect what your account
  is authorized to see, exactly as if you viewed the dialog manually — this
  extension can't see anything your account couldn't already see on
  instagram.com.
- **Terms of Service.** Automated collection of data from Instagram, even of
  your own followers/following lists, may be against Instagram's Terms of
  Service. Using this extension carries some risk to your account (e.g.
  temporary action blocks) if used excessively or on very large accounts.
  Use at your own discretion, and avoid running checks back-to-back
  repeatedly in a short period.
- **No DOM-scraping fallback is implemented.** If Instagram's internal API
  endpoints change shape or are removed, this extension will need to be
  updated — there isn't a secondary scraping path built in, since a reliable
  DOM-based approach would need to be redesigned against Instagram's current
  markup at that time.

---

## Debugging

- **Background service worker logs:** go to `chrome://extensions`, find
  "Instagram Unfollow Tracker", click **service worker** under "Inspect
  views" to open its DevTools console.
- **Content script logs:** open DevTools on an instagram.com tab itself
  (right-click → Inspect) — `content.js` runs in that page's context.
- **Popup logs:** right-click the popup while it's open → Inspect (or open
  the popup, then open DevTools and select the popup's document from the
  context dropdown, since right-clicking can close the popup on some
  platforms).
- **Stored state:** in any of the above consoles, run:
  ```js
  chrome.storage.local.get(null, console.log);
  ```
  to see the current `scanState`, `snapshot`, and `results` objects.
- **Reset all data:** run `chrome.storage.local.clear()` in any console tied
  to the extension, then reload the extension from `chrome://extensions`.
- **"Could not communicate with the Instagram tab":** usually means the
  content script hasn't attached yet (e.g. the tab was just opened).
  Background automatically retries once after reloading the tab; if it still
  fails, manually reload the instagram.com tab and try **Check now** again.

---

## Privacy

- All follower/following data is stored **only** in `chrome.storage.local`,
  local to your browser profile. Nothing is sent to any server other than
  Instagram's own domain (`instagram.com`), which your browser was already
  talking to.
- The extension does not read, store, or transmit your Instagram password,
  session cookies' raw values, or any authentication tokens — it relies on
  the browser automatically attaching your existing session cookies to
  requests to instagram.com, the same way any normal page load does.
- No analytics, telemetry, or third-party network calls of any kind.
- Uninstalling the extension removes all locally stored data.
