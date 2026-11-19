const DEFAULT_STATE = {
  enabled: false,
  deleteNonProjectChatsEnabled: false,
  continueText: "continue",
  downloadSubfolder: "ChatGPT",
  delayBeforeDownloadMs: 10000,
  delayBetweenDownloadsMs: 2000,
  downloadedKeys: [],
  status: "Ready"
};

const DOWNLOAD_COMPLETE_TIMEOUT_MS = 10 * 60 * 1000;
const CLICK_DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;
const DOWNLOAD_WATCH_RESULT_TTL_MS = 5 * 60 * 1000;

const activeDownloadWatches = new Map();
let nextDownloadWatchId = 1;

async function getState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_STATE, (items) => {
      resolve({ ...DEFAULT_STATE, ...items });
    });
  });
}

async function setState(patch) {
  return new Promise((resolve) => {
    chrome.storage.local.set(patch, resolve);
  });
}

function sanitizeFilenamePart(value) {
  return String(value || "chatgpt-file")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function extensionFromLabel(label) {
  const lower = String(label || "").toLowerCase();
  if (lower.includes("zip")) return ".zip";
  if (lower.includes("jsonl")) return ".jsonl";
  if (lower.includes("json")) return ".json";
  if (lower.includes("markdown") || lower.includes("md")) return ".md";
  if (lower.includes("csv")) return ".csv";
  if (lower.includes("report")) return ".md";
  return "";
}

function buildFilename(file, subfolder) {
  const label = sanitizeFilenamePart(file.label);
  const ext = extensionFromLabel(label);
  const hasKnownExt = /\.[a-z0-9]{2,8}$/i.test(label);
  const name = hasKnownExt || !ext ? label : `${label}${ext}`;
  const folder = sanitizeFilenamePart(subfolder || "ChatGPT");
  return `${folder}/${name}`;
}

function waitForDownloadComplete(downloadId, timeoutMs = DOWNLOAD_COMPLETE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(onChanged);
      reject(new Error("Download timed out before completion."));
    }, timeoutMs);

    function finish(error) {
      clearTimeout(timeoutId);
      chrome.downloads.onChanged.removeListener(onChanged);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    }

    function onChanged(delta) {
      if (delta.id !== downloadId || !delta.state?.current) return;

      if (delta.state.current === "complete") {
        finish();
        return;
      }

      if (delta.state.current === "interrupted") {
        finish(new Error("Download was interrupted."));
      }
    }

    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id: downloadId }, (items) => {
      const err = chrome.runtime.lastError;
      if (err) {
        finish(new Error(err.message));
        return;
      }

      const item = items[0];
      if (!item) {
        finish(new Error("Download item was not found."));
        return;
      }

      if (item.state === "complete") {
        finish();
        return;
      }

      if (item.state === "interrupted") {
        finish(new Error("Download was interrupted."));
      }
    });
  });
}

function createDownloadWatch(startedAt = Date.now(), timeoutMs = CLICK_DOWNLOAD_TIMEOUT_MS) {
  const watchId = String(nextDownloadWatchId);
  nextDownloadWatchId += 1;

  let watchedDownloadId = null;
  let settled = false;

  const promise = new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      finish(new Error("No download completed after the click."));
    }, timeoutMs);

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      chrome.downloads.onCreated.removeListener(onCreated);
      chrome.downloads.onChanged.removeListener(onChanged);

      if (error) {
        reject(error);
      } else {
        resolve(result);
      }

      setTimeout(() => {
        activeDownloadWatches.delete(watchId);
      }, DOWNLOAD_WATCH_RESULT_TTL_MS);
    }

    function shouldWatchItem(item) {
      const itemStartedAt = Date.parse(item.startTime || "");
      return Number.isFinite(itemStartedAt) && itemStartedAt >= startedAt;
    }

    function watchItem(item) {
      if (settled || watchedDownloadId !== null || !shouldWatchItem(item)) return;

      watchedDownloadId = item.id;
      if (item.state === "complete") {
        finish(null, { downloadId: item.id, filename: item.filename });
        return;
      }

      if (item.state === "interrupted") {
        finish(new Error("Download was interrupted."));
      }
    }

    function onCreated(item) {
      watchItem(item);
    }

    function onChanged(delta) {
      if (delta.id !== watchedDownloadId || !delta.state?.current) return;

      if (delta.state.current === "complete") {
        chrome.downloads.search({ id: delta.id }, (items) => {
          const item = items[0];
          finish(null, { downloadId: delta.id, filename: item?.filename || "" });
        });
        return;
      }

      if (delta.state.current === "interrupted") {
        finish(new Error("Download was interrupted."));
      }
    }

    chrome.downloads.onCreated.addListener(onCreated);
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search(
      {
        startedAfter: new Date(startedAt).toISOString(),
        orderBy: ["-startTime"],
        limit: 5
      },
      (items) => {
        const err = chrome.runtime.lastError;
        if (err) {
          finish(new Error(err.message));
          return;
        }

        items.reverse().forEach(watchItem);
      }
    );
  });

  promise.catch(() => {});
  activeDownloadWatches.set(watchId, promise);
  return watchId;
}

async function downloadUrl(file) {
  const state = await getState();
  const key = file.key || file.url || file.label;

  if (state.downloadedKeys.includes(key)) {
    return { skipped: true, reason: "This file was already downloaded." };
  }

  const filename = buildFilename(file, state.downloadSubfolder);

  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: file.url,
        filename,
        conflictAction: "uniquify",
        saveAs: false
      },
      async (downloadId) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }

        try {
          await waitForDownloadComplete(downloadId);
        } catch (error) {
          reject(error);
          return;
        }

        const downloadedKeys = [...state.downloadedKeys, key].slice(-500);
        await setState({
          downloadedKeys,
          lastDownload: {
            id: downloadId,
            label: file.label,
            filename,
            at: new Date().toISOString()
          },
          status: `Downloaded: ${file.label}`
        });
        resolve({ downloadId, filename });
      }
    );
  });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  if (!["install", "update"].includes(details.reason)) return;

  const current = await new Promise((resolve) => {
    chrome.storage.local.get(["continueText"], resolve);
  });

  await setState({
    enabled: false,
    deleteNonProjectChatsEnabled: false,
    continueText: current.continueText || DEFAULT_STATE.continueText,
    status: "Ready"
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === "GET_STATE") {
      sendResponse(await getState());
      return;
    }

    if (message?.type === "SET_STATE") {
      await setState(message.patch || {});
      sendResponse(await getState());
      return;
    }

    if (message?.type === "RESET_HISTORY") {
      await setState({ downloadedKeys: [], lastDownload: null, status: "Download history cleared" });
      sendResponse(await getState());
      return;
    }

    if (message?.type === "STATUS") {
      await setState({ status: message.status || "Running" });
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "DOWNLOAD_FILE" && message.file?.url) {
      const result = await downloadUrl(message.file);
      sendResponse({ ok: true, ...result });
      return;
    }

    if (message?.type === "START_DOWNLOAD_WATCH") {
      const watchId = createDownloadWatch(message.startedAt || Date.now());
      sendResponse({ ok: true, watchId });
      return;
    }

    if (message?.type === "WAIT_DOWNLOAD_WATCH" && message.watchId) {
      const promise = activeDownloadWatches.get(String(message.watchId));
      if (!promise) {
        sendResponse({ ok: false, error: "Download watch was not found." });
        return;
      }

      const result = await promise;
      sendResponse({ ok: true, ...result });
      return;
    }

    if (message?.type === "MARK_DOWNLOADED" && message.file?.key) {
      const state = await getState();
      const downloadedKeys = [...state.downloadedKeys, message.file.key].slice(-500);
      await setState({
        downloadedKeys,
        lastDownload: {
          label: message.file.label,
          filename: message.file.label,
          at: new Date().toISOString()
        },
        status: `Downloaded: ${message.file.label}`
      });
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: "Unknown message" });
  })().catch(async (error) => {
    await setState({ status: `Error: ${error.message}` });
    sendResponse({ ok: false, error: error.message });
  });

  return true;
});
