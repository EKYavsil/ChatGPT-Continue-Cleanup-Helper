const fields = {
  enabled: document.querySelector("#enabled"),
  deleteNonProjectChatsEnabled: document.querySelector("#deleteNonProjectChatsEnabled"),
  continueText: document.querySelector("#continueText"),
  downloadSubfolder: document.querySelector("#downloadSubfolder"),
  delayBeforeDownloadSeconds: document.querySelector("#delayBeforeDownloadSeconds"),
  delayBetweenDownloadsSeconds: document.querySelector("#delayBetweenDownloadsSeconds"),
  status: document.querySelector("#status"),
  resetHistory: document.querySelector("#resetHistory")
};

const DEFAULT_DELAY_BEFORE_DOWNLOAD_MS = 10000;
const DEFAULT_DELAY_BETWEEN_DOWNLOADS_MS = 2000;
const MAX_DELAY_BEFORE_DOWNLOAD_MS = 60000;
const MAX_DELAY_BETWEEN_DOWNLOADS_MS = 10000;

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => resolve(response));
  });
}

function msToSeconds(value, fallback) {
  return (value ?? fallback) / 1000;
}

async function loadState() {
  const state = await sendMessage({ type: "GET_STATE" });
  fields.enabled.checked = Boolean(state.enabled);
  fields.deleteNonProjectChatsEnabled.checked = Boolean(state.deleteNonProjectChatsEnabled);
  fields.continueText.value = state.continueText || "continue";
  fields.downloadSubfolder.value = state.downloadSubfolder || "ChatGPT";
  fields.delayBeforeDownloadSeconds.value = String(
    msToSeconds(state.delayBeforeDownloadMs, DEFAULT_DELAY_BEFORE_DOWNLOAD_MS)
  );
  fields.delayBetweenDownloadsSeconds.value = String(
    msToSeconds(state.delayBetweenDownloadsMs, DEFAULT_DELAY_BETWEEN_DOWNLOADS_MS)
  );
  fields.status.textContent = state.status || "Ready";
}

async function refreshStatus() {
  const state = await sendMessage({ type: "GET_STATE" });
  fields.status.textContent = state?.status || "Ready";
}

function secondsToMsOrDefault(value, fallbackMs, maxMs) {
  if (String(value).trim() === "") return fallbackMs;
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return fallbackMs;
  return Math.round(Math.min(Math.max(seconds * 1000, 0), maxMs));
}

async function saveState() {
  await sendMessage({
    type: "SET_STATE",
    patch: {
      enabled: fields.enabled.checked,
      deleteNonProjectChatsEnabled: fields.deleteNonProjectChatsEnabled.checked,
      continueText: fields.continueText.value.trim() || "continue",
      downloadSubfolder: fields.downloadSubfolder.value.trim() || "ChatGPT",
      delayBeforeDownloadMs: secondsToMsOrDefault(
        fields.delayBeforeDownloadSeconds.value,
        DEFAULT_DELAY_BEFORE_DOWNLOAD_MS,
        MAX_DELAY_BEFORE_DOWNLOAD_MS
      ),
      delayBetweenDownloadsMs: secondsToMsOrDefault(
        fields.delayBetweenDownloadsSeconds.value,
        DEFAULT_DELAY_BETWEEN_DOWNLOADS_MS,
        MAX_DELAY_BETWEEN_DOWNLOADS_MS
      )
    }
  });
  await loadState();
}

function debounce(fn, delayMs = 250) {
  let timeoutId = 0;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delayMs);
  };
}

const saveStateSoon = debounce(saveState);

fields.enabled.addEventListener("change", saveState);
fields.deleteNonProjectChatsEnabled.addEventListener("change", saveState);
fields.continueText.addEventListener("input", saveStateSoon);
fields.downloadSubfolder.addEventListener("input", saveStateSoon);
fields.delayBeforeDownloadSeconds.addEventListener("input", saveStateSoon);
fields.delayBetweenDownloadsSeconds.addEventListener("input", saveStateSoon);

fields.resetHistory.addEventListener("click", async () => {
  await sendMessage({ type: "RESET_HISTORY" });
  await loadState();
});

loadState();
setInterval(refreshStatus, 1000);
