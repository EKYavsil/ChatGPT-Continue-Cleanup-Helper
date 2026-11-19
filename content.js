const LOOP_INTERVAL_MS = 1400;
const DEBUG_PREFIX = "[ChatGPT File Continue & Cleanup Helper]";

let isWorking = false;
let isDeletingChats = false;
let apiDeleteCursor = 0;
const protectedConversationIds = new Set();
const reviewedSidebarIds = new Set();
let nextApiDeleteAt = 0;
let cachedAccessToken = "";
let cachedAccessTokenAt = 0;

console.info(`${DEBUG_PREFIX} content script loaded`);

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        console.warn(DEBUG_PREFIX, chrome.runtime.lastError.message);
        resolve(null);
        return;
      }
      resolve(response);
    });
  });
}

async function getState() {
  return sendMessage({ type: "GET_STATE" });
}

function visible(element) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}

function findComposer() {
  return (
    document.querySelector('form[data-thread-find-composer] [data-composer-markdown][contenteditable="true"]') ||
    document.querySelector("#prompt-textarea") ||
    document.querySelector('div.ProseMirror[contenteditable="true"]') ||
    document.querySelector('textarea[data-id="root"]') ||
    document.querySelector('textarea[placeholder]') ||
    document.querySelector('[contenteditable="true"][role="textbox"]') ||
    document.querySelector('[contenteditable="true"]')
  );
}

function isGenerating() {
  const stopButton = document.querySelector(
    'button[data-testid="stop-button"], button[aria-label*="Stop"]'
  );
  if (visible(stopButton)) return true;

  const streaming = document.querySelector(".result-streaming, [data-message-streaming='true']");
  return visible(streaming);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function textOf(element) {
  return String(element?.innerText || element?.textContent || element?.getAttribute?.("aria-label") || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function sidebarConversationId(link) {
  try {
    const href = link.getAttribute("href")?.trim();
    if (!href || /^[?#]/.test(href)) return "";
    const url = new URL(href, document.baseURI);
    if (url.origin !== location.origin) return "";
    return url.pathname.match(/^\/c\/([a-z0-9_-]+)\/?$/i)?.[1] || "";
  } catch {
    return "";
  }
}

function findSidebarRoot() {
  const roots = [...document.querySelectorAll("aside, nav, [role='navigation']")].filter(visible);
  return roots.find((root) => {
    const text = normalizeText(textOf(root));
    return text.includes("recent") || text.includes("new chat");
  });
}

function isInSidebarColumn(elementOrRect) {
  const rect = elementOrRect?.left === undefined ? elementOrRect.getBoundingClientRect() : elementOrRect;
  const sidebarLimit = Math.min(420, Math.max(260, window.innerWidth * 0.28));
  return rect.left >= -5 && rect.left <= sidebarLimit;
}

function closestConversationRow(element) {
  let current = element;

  for (let depth = 0; current && depth < 6; depth += 1) {
    if (current.querySelector?.("button,[role='button']")) return current;
    current = current.parentElement;
  }

  return (
    element.closest("li") ||
    element.closest('[data-testid*="history"]') ||
    element.closest('[role="listitem"]') ||
    element.closest("div")
  );
}

function hasProjectHint(element) {
  let current = element;

  for (let depth = 0; current && depth < 5; depth += 1) {
    const haystack = normalizeText(
      `${current.getAttribute?.("aria-label") || ""} ${current.getAttribute?.("data-testid") || ""} ${current.className || ""}`
    );
    if (haystack.includes("project")) return true;
    current = current.parentElement;
  }

  return false;
}

function isInProjectSection(link, sidebar) {
  if (hasProjectHint(link)) return true;

  const items = [...sidebar.querySelectorAll("h1,h2,h3,[role='heading'],button,a,div,span")].filter(visible);
  const linkIndex = items.findIndex((item) => item === link || item.contains(link));
  if (linkIndex < 0) return false;

  let lastProjectMarker = -1;
  let lastNormalChatMarker = -1;

  for (let index = 0; index < linkIndex; index += 1) {
    const text = normalizeText(textOf(items[index]));
    if (!text) continue;

    if (text === "projects") lastProjectMarker = index;
    if (
      text === "chats" ||
      text === "today" ||
      text === "yesterday" ||
      text.includes("previous")
    ) {
      lastNormalChatMarker = index;
    }
  }

  return lastProjectMarker > lastNormalChatMarker;
}

function isRecentChatsMarker(text) {
  return text === "recent" || text === "recents" || text === "today" || text === "yesterday";
}

function includesRecentChatsMarker(text) {
  return text.includes("recent") || text.includes("today") || text.includes("yesterday");
}

function isSidebarStopMarker(text) {
  return text === "projects" || text === "gpts" || text === "more";
}

function includesSidebarStopMarker(text) {
  return text.includes("projects") || text.includes("gpts");
}

function looksLikeConversationRow(row) {
  if (!row || !visible(row) || hasProjectHint(row)) return false;

  const text = normalizeText(textOf(row));
  if (!text || isRecentChatsMarker(text) || isSidebarStopMarker(text)) return false;
  if (includesRecentChatsMarker(text) || includesSidebarStopMarker(text)) return false;
  if (text.includes("new chat") || text.includes("search chats")) return false;
  if (text.includes("chatgpt") || text.includes("codex")) return false;

  const rect = row.getBoundingClientRect();
  if (rect.height > 80) return false;

  return true;
}

function nextSidebarConversationId() {
  const sidebar = findSidebarRoot();
  if (!sidebar) return "";
  for (const link of sidebar.querySelectorAll("a[href]")) {
    const id = sidebarConversationId(link);
    if (!id || protectedConversationIds.has(id.toLowerCase()) || reviewedSidebarIds.has(id)) continue;
    if (!visible(link) || !isInSidebarColumn(link) || isInProjectSection(link, sidebar)) continue;
    if (looksLikeConversationRow(closestConversationRow(link))) return id;
  }
  return "";
}

async function getAccessToken() {
  if (cachedAccessToken && Date.now() - cachedAccessTokenAt < 10 * 60 * 1000) {
    return cachedAccessToken;
  }

  const response = await fetch("/api/auth/session", {
    credentials: "include",
    headers: { accept: "application/json" }
  });

  if (!response.ok) return "";

  const session = await response.json().catch(() => ({}));
  cachedAccessToken = session.accessToken || "";
  cachedAccessTokenAt = Date.now();
  return cachedAccessToken;
}

async function chatgptBackendFetch(path, options = {}) {
  const token = await getAccessToken();
  const headers = {
    accept: "application/json",
    ...(options.body ? { "content-type": "application/json" } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {})
  };

  return fetch(path, {
    credentials: "include",
    referrer: location.origin,
    ...options,
    headers
  });
}

function retryDelayFromResponse(response) {
  const retryAfter = response.headers.get("retry-after");
  const seconds = Number(retryAfter);

  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, 5 * 60 * 1000);
  }

  const date = Date.parse(retryAfter || "");
  if (Number.isFinite(date)) {
    return Math.min(Math.max(date - Date.now(), 0), 5 * 60 * 1000);
  }

  return 60 * 1000;
}

function formatDelay(ms) {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  return `${Math.ceil(seconds / 60)} min`;
}

function findConversationItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.conversations)) return payload.conversations;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function projectReferences(conversation) {
  return [
    conversation.project_id, conversation.projectId, conversation.project,
    conversation.workspace_project_id, conversation.current_project_id,
    conversation.conversation_origin?.project_id, conversation.metadata?.project_id,
    conversation.metadata?.projectId
  ];
}

function conversationId(conversation) {
  if (conversation?.id && conversation.conversation_id && conversation.id !== conversation.conversation_id) return "";
  const id = conversation?.id || conversation?.conversation_id;
  return typeof id === "string" && /^[a-z0-9_-]+$/i.test(id) ? id : "";
}

function rememberProject(conversation) {
  if (!conversation || !projectReferences(conversation).some(Boolean)) return;
  for (const id of [conversation.id, conversation.conversation_id]) {
    if (typeof id === "string" && id) protectedConversationIds.add(id.toLowerCase());
  }
}

async function listConversationPage(offset) {
  const params = new URLSearchParams({
    offset: String(offset),
    limit: "50",
    order: "updated",
    is_archived: "false",
    is_starred: "false"
  });

  const response = await chatgptBackendFetch(`/backend-api/conversations?${params.toString()}`);
  if (response.status === 429) {
    const delay = retryDelayFromResponse(response);
    nextApiDeleteAt = Date.now() + delay;
    throw new Error(`API rate limit hit; waiting ${formatDelay(delay)}`);
  }

  if (!response.ok) {
    throw new Error(`List API error: ${response.status}`);
  }

  const payload = await response.json();
  return findConversationItems(payload);
}

async function deleteConversationByApi(conversation) {
  const id = conversationId(conversation);
  if (!id || protectedConversationIds.has(id.toLowerCase())) return;
  if (!(await getState())?.deleteNonProjectChatsEnabled) return;

  const title = conversation.title || conversation.name || id;
  await sendMessage({ type: "STATUS", status: `Deleting with API: ${title}` });

  const response = await chatgptBackendFetch(`/backend-api/conversation/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ is_visible: false })
  });

  if (response.status === 429) {
    const delay = retryDelayFromResponse(response);
    nextApiDeleteAt = Date.now() + delay;
    throw new Error(`API rate limit hit; waiting ${formatDelay(delay)}`);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Delete API error: ${response.status}${detail ? ` ${detail.slice(0, 80)}` : ""}`);
  }

  reviewedSidebarIds.add(id);
  nextApiDeleteAt = Date.now() + 7000;
  await wait(800);
  await sendMessage({ type: "STATUS", status: `Deleted with API: ${title}` });
}

async function deleteNonProjectChatByApi() {
  if (Date.now() < nextApiDeleteAt) {
    await sendMessage({
      type: "STATUS",
      status: `Waiting for API rate limit: ${formatDelay(nextApiDeleteAt - Date.now())}`
    });
    return true;
  }

  for (let page = 0; page < 5; page += 1) {
    const conversations = await listConversationPage(apiDeleteCursor);
    if (!conversations.length) {
      apiDeleteCursor = 0;
      return false;
    }

    conversations.forEach(rememberProject);
    const candidate = conversations.find((item) => {
      const id = conversationId(item);
      return id && !protectedConversationIds.has(id.toLowerCase());
    });
    if (candidate) {
      await deleteConversationByApi(candidate);
      return true;
    }
    apiDeleteCursor += 50;
  }
  return true;
}

async function checkSidebarConversation(id) {
  const response = await chatgptBackendFetch(`/backend-api/conversation/${encodeURIComponent(id)}`);
  if (response.status === 403 || response.status === 404 || response.status === 410) {
    reviewedSidebarIds.add(id);
    return;
  }
  if (response.status === 429) {
    nextApiDeleteAt = Date.now() + retryDelayFromResponse(response);
  }
  if (!response.ok) throw new Error(`Conversation lookup failed: ${response.status}`);

  const detail = await response.json();
  rememberProject(detail);
  if (conversationId(detail) === id && !protectedConversationIds.has(id.toLowerCase())) {
    const refs = projectReferences(detail);
    if (refs.includes(null) && refs.every((ref) => ref == null)) {
      await deleteConversationByApi(detail);
      return;
    }
  }

  reviewedSidebarIds.add(id);
}

async function deleteNonProjectChatTick() {
  if (isDeletingChats) return;

  isDeletingChats = true;
  try {
    const apiDeleted = await deleteNonProjectChatByApi();
    if (apiDeleted) return;

    if (!/^en(?:-|$)/i.test(document.documentElement.lang)) {
      await sendMessage({
        type: "STATUS",
        status: "No eligible chat found by the API. Sidebar cleanup requires an English interface."
      });
      return;
    }

    const id = nextSidebarConversationId();
    if (id) {
      await checkSidebarConversation(id);
    } else {
      await sendMessage({ type: "STATUS", status: "No chat found" });
    }
  } catch (error) {
    await sendMessage({ type: "STATUS", status: `Delete error: ${error.message}` });
  } finally {
    isDeletingChats = false;
  }
}

let lastView = "";
let modeVersion = 0;
let retryAt = 0;
let retryView = "";
let failedView = "";
let wakeTimer;
let lastStatus = "";
const nodeKeys = new WeakMap();
let nextNodeKey = 0;
let replyRevision = 0;

function currentView() {
  const id = ChatFiles.conversationId(location.pathname);
  if (!id || document.visibilityState !== "visible" || isGenerating()) return null;
  const rows = document.querySelectorAll("[data-message-author-role]");
  const row = rows[rows.length - 1];
  if (row && row.getAttribute("data-message-author-role") !== "assistant") return null;
  const turns = row ? [] : document.querySelectorAll("main article, main [data-testid^='conversation-turn-']");
  const tail = row || turns[turns.length - 1] || document.querySelector("main");
  if (!tail) return null;
  const messageId = row?.closest("[data-message-id]")?.getAttribute("data-message-id");
  if (!nodeKeys.has(tail)) nodeKeys.set(tail, ++nextNodeKey);
  return { id, messageId, key: id + "/" + (messageId || nodeKeys.get(tail)) };
}

function composerText(box) {
  return (box?.value ?? box?.textContent ?? "").replace(/[\u200B\uFEFF]/g, "");
}

function hasAttachments(box) {
  return Boolean(box?.closest("form")?.querySelector(
    '[data-testid*="remove-file"],[data-testid*="remove-attachment"],[data-testid="file-thumbnail"]'
  ));
}

function hasDraft(box) {
  return Boolean(composerText(box)) || hasAttachments(box);
}

function setText(box, text) {
  box.focus();
  if (box.tagName === "TEXTAREA") {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), "value")?.set;
    if (setter) setter.call(box, text);
    else box.value = text;
    box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  } else {
    const selection = document.getSelection();
    if (text) {
      const range = document.createRange();
      range.selectNodeContents(box.querySelector("p") || box);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand("insertText", false, text);
    } else {
      selection.selectAllChildren(box);
      document.execCommand("delete", false);
    }
  }
}

function sendButton(box) {
  const form = box.closest("form");
  const selector = 'button[data-testid="send-button"], button#composer-submit-button, button[data-composer-submit]:not([data-composer-submit="false"])';
  const buttons = form ? form.querySelectorAll("button") : document.querySelectorAll(selector);
  for (const button of buttons) {
    if (!visible(button) || button.disabled || button.getAttribute("aria-disabled") === "true") continue;
    const label = normalizeText(button.getAttribute("aria-label") || button.title || button.textContent)
      .replace(/\s*\((?:enter|return)\)$/, "");
    if (button.matches("[data-composer-voice-start], [data-composer-stop]") ||
        /voice|speech|stop|dictat|sesli|dikte|durdur/.test(label + " " + (button.dataset.testid || ""))) continue;
    const namedSend = /^(?:send(?: (?:message|prompt))?|(?:mesaj[ıi]? |istem[iı]? |ileti(?:yi)? )?gonder)$/.test(label);
    if (button.matches(selector) || (form && (namedSend ||
        (button.matches('button[type="submit"]') && (!label || label === "submit"))))) {
      return button;
    }
  }
  return null;
}

async function report(status) {
  if (status === lastStatus) return;
  lastStatus = status;
  await sendMessage({ type: "STATUS", status });
}

class Paused extends Error {}

async function ensureActive(view, version) {
  const state = await getState();
  if (!state?.enabled || state.deleteNonProjectChatsEnabled || version !== modeVersion ||
      currentView()?.key !== view.key) throw new Paused();
  return state;
}

async function operation(type, reply, extra = {}) {
  const result = await sendMessage({ type, conversationId: reply.conversationId, replyId: reply.replyId, ...extra });
  if (!result || result.paused) throw new Paused();
  if (result.error) throw new Error(result.error);
  return result;
}

async function saveFile(reply, file, record, view, version) {
  if (record?.state === "complete") return;
  let state = record?.state;
  if (!state || state === "interrupted") {
    const delivery = await ChatFiles.resolve(file, location.origin, chatgptBackendFetch);
    await ensureActive(view, version);
    ({ state } = await operation("START_FILE", reply, { fileId: file.id, file: { name: file.name, ...delivery } }));
  }
  while (state === "in_progress") {
    await ensureActive(view, version);
    ({ state } = await operation("CHECK_FILE", reply, { fileId: file.id }));
    if (state === "in_progress") await wait(750);
  }
  if (state === "starting") throw new Error("Download start is uncertain. Check browser downloads.");
  if (state === "unverified") throw new Error("Downloaded content did not match the expected file.");
  if (state !== "complete") throw new Error("Download interrupted. Toggle Continue to retry.");
}

function userMessages() {
  return [...document.querySelectorAll('[data-message-author-role="user"]')];
}

async function followUp(reply, view, version, text) {
  const box = findComposer();
  if (!box || hasDraft(box)) {
    await report("Waiting for an empty message box");
    return false;
  }
  const previousRows = userMessages();
  const previousIds = new Set(previousRows.map(row => row.closest?.("[data-message-id]")?.getAttribute("data-message-id")).filter(Boolean));
  let edited = false;
  const onEdit = event => { if (event.isTrusted) edited = true; };
  const ownsDraft = () => !edited && findComposer() === box && composerText(box) === text;
  async function retrySend() {
    retryView = view.key;
    retryAt = Date.now() + 15000;
    const status = ownsDraft() && !hasAttachments(box)
      ? "Waiting for the send button. Will retry."
      : "Message box changed. Waiting before retry.";
    await report(status);
    return false;
  }
  let reservation;
  let clicked = false;
  try {
    setText(box, text);
    box.addEventListener("beforeinput", onEdit, true);
    for (let poll = 0; poll < 20; poll++) {
      await ensureActive(view, version);
      if (!ownsDraft() || hasAttachments(box)) break;
      if (sendButton(box)) break;
      await wait(250);
    }
    if (!ownsDraft() || hasAttachments(box) || !sendButton(box)) {
      return await retrySend();
    }
    const result = await operation("RESERVE_SEND", reply, { fileIds: reply.files.map(file => file.id) });
    reservation = result.reservation;
    if (!reservation) return true;
    if (!(await sendMessage({ type: "ACTIVE_CHAT", conversationId: view.id }))?.active) throw new Paused();
    await ensureActive(view, version);
    const button = sendButton(box);
    if (!ownsDraft() || hasAttachments(box) || !button) return await retrySend();
    clicked = true;
    button.click();
    for (let i = 0; i < 24; i++) {
      if (ChatFiles.conversationId(location.pathname) !== view.id) break;
      const rows = userMessages();
      const row = rows[rows.length - 1];
      const id = row?.closest?.("[data-message-id]")?.getAttribute("data-message-id");
      const appended = id ? !previousIds.has(id) : rows.length > previousRows.length;
      if (appended && row?.innerText?.trim() === text) {
        await operation("CONFIRM_SEND", reply, { reservation });
        await report("Continue message sent");
        return true;
      }
      await wait(250);
    }
    await report("Send unconfirmed. Check the conversation before continuing.");
    return true;
  } finally {
    box.removeEventListener("beforeinput", onEdit, true);
    if (!clicked && ownsDraft() && !hasAttachments(box)) setText(box, "");
    if (!clicked && reservation) {
      await sendMessage({ type: "CANCEL_SEND", conversationId: reply.conversationId, replyId: reply.replyId, reservation });
    }
  }
}

async function processReply(view, version, state) {
  const reply = await ChatFiles.latest(view.id, chatgptBackendFetch);
  await ensureActive(view, version);
  if (!reply || (view.messageId && view.messageId !== reply.replyId)) {
    retryAt = Date.now() + 15000;
    retryView = view.key;
    await report("Waiting for the latest completed reply");
    return false;
  }
  if (!reply.files.length) {
    await report("No generated files in the latest reply");
    return true;
  }
  const { batch } = await operation("BATCH_STATE", reply);
  if (batch.followup !== "ready") {
    await report(batch.followup === "sent" ? "Continue already sent for this reply" : "Previous send unconfirmed. Check the conversation.");
    return true;
  }
  if (reply.files.some(file => batch.files[file.id]?.state !== "complete")) {
    await wait(state.delayBeforeDownloadMs);
    for (const [index, file] of reply.files.entries()) {
      await ensureActive(view, version);
      if (batch.files[file.id]?.state === "complete") continue;
      await report(`Downloading file ${index + 1} of ${reply.files.length}`);
      await saveFile(reply, file, batch.files[file.id], view, version);
      await wait(state.delayBetweenDownloadsMs);
    }
  }
  state = await ensureActive(view, version);
  if (!findComposer() || hasDraft(findComposer())) {
    await report("Waiting for an empty message box");
    return true;
  }
  const latest = await ChatFiles.latest(view.id, chatgptBackendFetch);
  await ensureActive(view, version);
  if (latest?.replyId !== reply.replyId || latest.files.length !== reply.files.length ||
      latest.files.some((file, i) => file.id !== reply.files[i].id)) return false;
  return followUp(reply, view, version, String(state.continueText || "").trim() || "continue");
}

async function tick({ allowCleanup = true } = {}) {
  if (isWorking) return;
  isWorking = true;
  let attempt = "";
  const version = modeVersion;
  try {
    const state = await getState();
    if (state?.deleteNonProjectChatsEnabled) {
      if (allowCleanup) await deleteNonProjectChatTick();
      return;
    }
    if (!state?.enabled) return;
    const view = currentView();
    if (!view) { lastView = ""; return; }
    const box = findComposer();
    attempt = [view.key, replyRevision, Boolean(box && !hasDraft(box))].join("/");
    if (failedView === view.key || attempt === lastView || (retryView === view.key && Date.now() < retryAt)) return;
    if (!(await sendMessage({ type: "ACTIVE_CHAT", conversationId: view.id }))?.active) return;
    await navigator.locks.request("chat-file-helper/" + view.id, { ifAvailable: true }, async lock => {
      if (lock && await processReply(view, version, state)) lastView = attempt;
    });
  } catch (error) {
    if (error instanceof Paused) return;
    if (error.retryMs) {
      retryAt = Date.now() + error.retryMs;
      retryView = currentView()?.key;
    } else {
      failedView = currentView()?.key || "";
    }
    await report(error.message + (error.retryMs ? " Waiting before retry." : ""));
  } finally {
    isWorking = false;
  }
}

function wake() {
  if (wakeTimer) return;
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    void tick({ allowCleanup: false });
  }, 400);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || (!changes.enabled && !changes.deleteNonProjectChatsEnabled)) return;
  modeVersion++;
  lastView = lastStatus = retryView = failedView = "";
  wake();
});
document.addEventListener("visibilitychange", () => {
  modeVersion++;
  wake();
});
window.addEventListener("popstate", wake);
new MutationObserver(records => {
  const changed = records.some(record => {
    const el = record.target.nodeType === 1 ? record.target : record.target.parentElement;
    return el?.closest("main") && !el.closest("form, [contenteditable], textarea, nav, header, footer");
  });
  if (changed) {
    replyRevision++;
    wake();
  }
}).observe(document.documentElement, { childList: true, characterData: true, subtree: true });
setInterval(tick, LOOP_INTERVAL_MS);
