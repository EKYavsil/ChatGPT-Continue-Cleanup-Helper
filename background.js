importScripts("file-api.js");

const DEFAULT_STATE = {
  enabled: false,
  deleteNonProjectChatsEnabled: false,
  continueText: "continue",
  downloadSubfolder: "ChatGPT",
  delayBeforeDownloadMs: 10000,
  delayBetweenDownloadsMs: 2000,
  status: "Ready"
};

const settings = () => chrome.storage.local.get(DEFAULT_STATE);
const write = (patch) => chrome.storage.local.set(patch);
let pending = Promise.resolve();

function serialize(operation) {
  const result = pending.then(operation);
  pending = result.catch(() => {});
  return result;
}

function filenamePart(value) {
  return String(value || "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim()
    .replace(/^\.+|[. ]+$/g, "").slice(0, 160) || "file";
}

function documentFormat(mime, name = "") {
  const type = String(mime || "").split(";")[0].trim().toLowerCase();
  if (type === "text/html" || type === "application/xhtml+xml" || /\.x?html?$/i.test(name)) return "html";
  if (/[/+]json$/.test(type) || /\.(?:[a-z]*json|jsonl|ipynb|map)$/i.test(name)) return "json";
  return "";
}

async function activeOrigin(sender, conversationId) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.url || tab.id !== sender.tab?.id || sender.frameId !== 0) return null;
  const url = new URL(tab.url);
  return ["https://chatgpt.com", "https://chat.openai.com"].includes(url.origin) &&
    ChatFiles.conversationId(url.pathname) === conversationId ? url.origin : null;
}

async function batchOperation(message, sender) {
  const { conversationId, replyId, fileId } = message;
  if (!ChatFiles.validId(conversationId) || !ChatFiles.validId(replyId)) throw new Error("Invalid reply identity.");
  const key = `batch/${conversationId}/${replyId}`;
  const batch = (await chrome.storage.local.get(key))[key] || { files: {}, followup: "ready" };
  if (message.type === "CANCEL_SEND") {
    if (batch.followup === "reserved" && typeof message.reservation === "string" &&
        message.reservation === batch.reservation) {
      batch.followup = "ready";
      delete batch.reservation;
      await write({ [key]: batch });
    }
    return { ok: true };
  }
  const state = await settings();
  const origin = await activeOrigin(sender, conversationId);
  if (!state.enabled || state.deleteNonProjectChatsEnabled || !origin) return { paused: true };
  if (message.type === "BATCH_STATE") return { batch };
  if (message.type === "CONFIRM_SEND") {
    if (batch.followup === "reserved" && (!message.reservation || message.reservation === batch.reservation)) {
      batch.followup = "sent";
      delete batch.reservation;
      await write({ [key]: batch });
    }
    return { batch };
  }
  if (batch.followup !== "ready") return { batch };
  if (message.type === "RESERVE_SEND") {
    const ids = message.fileIds;
    if (!Array.isArray(ids) || !ids.length || !ids.every(id => ChatFiles.validFileId(id) && batch.files[id]?.state === "complete")) {
      throw new Error("The reply still has unfinished downloads.");
    }
    batch.followup = "reserved";
    batch.reservation = crypto.randomUUID();
    await write({ [key]: batch });
    return { reserved: true, reservation: batch.reservation };
  }

  if (!ChatFiles.validFileId(fileId)) throw new Error("Invalid file identity.");
  const record = batch.files[fileId];
  if (message.type === "START_FILE") {
    if (record && record.state !== "interrupted") return { state: record.state };
    const { size, name, url, mime } = message.file;
    if (typeof name !== "string" || (size !== null && (!Number.isSafeInteger(size) || size < 0))) {
      throw new Error("Invalid download metadata.");
    }
    const address = ChatFiles.contentURL(url, origin, fileId);
    batch.files[fileId] = { state: "starting", size };
    await write({ [key]: batch });
    let id;
    try {
      id = await chrome.downloads.download({
        url: address, filename: filenamePart(state.downloadSubfolder) + "/" + filenamePart(name),
        conflictAction: "uniquify", saveAs: false
      });
    } catch {
      batch.files[fileId].state = "interrupted";
      await write({ [key]: batch });
      throw new Error("The browser could not start this download.");
    }
    batch.files[fileId] = { id, size, format: documentFormat(mime, name), state: "in_progress" };
    await write({ [key]: batch });
    return { state: "in_progress" };
  }

  if (message.type !== "CHECK_FILE" || !record) throw new Error("Unknown download.");
  if (record.state !== "in_progress") return { state: record.state };
  const [item] = await chrome.downloads.search({ id: record.id });
  if (!item || item.state === "interrupted") {
    record.state = "interrupted";
  } else if (item.state === "complete") {
    let valid = false;
    try {
      ChatFiles.contentURL(item.finalUrl || item.url, origin, fileId);
      const format = documentFormat(item.mime);
      valid = (!format || format === record.format) && (record.size === null || record.size === item.bytesReceived);
    } catch { /* The server returned a different resource. */ }
    record.state = valid ? "complete" : "unverified";
  } else {
    return { state: "in_progress" };
  }
  await write({ [key]: batch });
  return { state: record.state };
}

const operations = new Set(["BATCH_STATE", "START_FILE", "CHECK_FILE", "RESERVE_SEND", "CANCEL_SEND", "CONFIRM_SEND"]);

async function handle(message, sender) {
  if (message.type === "ACTIVE_CHAT") return { active: Boolean(await activeOrigin(sender, message.conversationId)) };
  if (operations.has(message.type)) return batchOperation(message, sender);
  if (message.type === "GET_STATE") return settings();
  if (message.type === "STATUS") {
    await write({ status: message.status || "Running" });
    return { ok: true };
  }
  if (sender.tab && sender.url !== chrome.runtime.getURL("popup.html")) throw new Error("Unknown request.");
  if (message.type === "SET_STATE") {
    const patch = {};
    for (const field of Object.keys(DEFAULT_STATE)) {
      if (field !== "status" && Object.hasOwn(message.patch, field)) patch[field] = message.patch[field];
    }
    await write(patch);
    return settings();
  }
  if (message.type === "RESET_HISTORY") {
    await write({ enabled: false });
    const keys = Object.keys(await chrome.storage.local.get(null));
    await chrome.storage.local.remove(keys.filter(key => key.startsWith("batch/") || ["downloadedKeys", "lastDownload"].includes(key)));
    await write({ status: "Download history cleared" });
    return settings();
  }
  throw new Error("Unknown request.");
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (!["install", "update"].includes(reason)) return;
  return serialize(async () => {
    await chrome.storage.local.remove(["downloadedKeys", "lastDownload"]);
    await write({ enabled: false, deleteNonProjectChatsEnabled: false, status: "Ready" });
  });
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  const action = operations.has(message.type) || message.type === "RESET_HISTORY"
    ? serialize(() => handle(message, sender))
    : handle(message, sender);
  action.then(reply, error => reply({ error: error.message }));
  return true;
});
