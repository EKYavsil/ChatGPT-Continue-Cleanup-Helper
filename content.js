const LOOP_INTERVAL_MS = 1400;
const AFTER_SEND_COOLDOWN_MS = 8000;
const DEBUG_PREFIX = "[ChatGPT File Continue & Cleanup Helper]";

let isWorking = false;
let isDeletingChats = false;
let apiDeleteCursor = 0;
const protectedConversationIds = new Set();
const reviewedSidebarIds = new Set();
let nextApiDeleteAt = 0;
let cachedAccessToken = "";
let cachedAccessTokenAt = 0;
let lastSentAt = 0;
let lastCandidateBatchKey = "";

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

function getAssistantMessages() {
  const roleMessages = [...document.querySelectorAll('[data-message-author-role="assistant"]')].filter(visible);
  if (roleMessages.length) return roleMessages;

  const articleMessages = [...document.querySelectorAll("article")].filter((node) => {
    const text = node.innerText || "";
    return text.trim().length > 0;
  });

  if (articleMessages.length) return articleMessages;

  return [];
}

function linkLooksDownloadable(link) {
  const text = (link.innerText || link.getAttribute("aria-label") || "").trim();
  const href = link.href || "";
  if (!href || href.startsWith("javascript:")) return false;

  const haystack = `${text} ${href}`.toLowerCase();
  return (
    link.hasAttribute("download") ||
    href.startsWith("blob:") ||
    href.startsWith("sandbox:") ||
    haystack.includes("download") ||
    haystack.includes("sandbox") ||
    haystack.includes("files") ||
    haystack.includes(".zip") ||
    haystack.includes(".jsonl") ||
    haystack.includes(".json") ||
    haystack.includes(".csv") ||
    haystack.includes(".md") ||
    haystack.includes("markdown")
  );
}

function linkLooksSafeFallback(link) {
  const href = link.href || "";
  if (!href || href.startsWith("javascript:") || href.startsWith("#")) return false;

  const haystack = `${textOf(link)} ${href} ${link.getAttribute("download") || ""}`.toLowerCase();
  if (haystack.includes("chatgpt.com/share/")) return false;
  if (haystack.includes("openai.com/policies")) return false;
  if (haystack.includes("help.openai.com")) return false;

  return (
    link.hasAttribute("download") ||
    href.startsWith("blob:") ||
    href.startsWith("sandbox:") ||
    haystack.includes("/files/") ||
    haystack.includes("file-") ||
    haystack.includes("download") ||
    haystack.includes("attachment")
  );
}

function clickableFor(element) {
  return element.closest('a[href], button, [role="button"], [tabindex]') || element;
}

function activate(element) {
  element.scrollIntoView({ block: "center", inline: "center" });
  const rect = element.getBoundingClientRect();
  const eventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: rect.left + Math.min(20, rect.width / 2),
    clientY: rect.top + Math.min(10, rect.height / 2)
  };

  element.dispatchEvent(new MouseEvent("pointerdown", eventInit));
  element.dispatchEvent(new MouseEvent("mousedown", eventInit));
  element.dispatchEvent(new MouseEvent("mouseup", eventInit));
  element.dispatchEvent(new MouseEvent("click", eventInit));
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

function looksLikeSaveControl(element) {
  const text = textOf(element).toLowerCase();
  const aria = String(element.getAttribute?.("aria-label") || "").toLowerCase();
  const title = String(element.getAttribute?.("title") || "").toLowerCase();
  const value = String(element.getAttribute?.("value") || "").toLowerCase();
  const haystack = `${text} ${aria} ${title} ${value}`;

  return element.hasAttribute("download") || haystack.includes("save") || haystack.includes("download");
}

function looksLikeFileControl(element) {
  const href = element.href || "";
  const download = String(element.getAttribute?.("download") || "");
  const aria = String(element.getAttribute?.("aria-label") || "");
  const title = String(element.getAttribute?.("title") || "");
  const testid = String(element.getAttribute?.("data-testid") || "");
  const haystack = `${textOf(element)} ${href} ${download} ${aria} ${title} ${testid}`.toLowerCase();

  return (
    element.matches?.("a[href]") ||
    haystack.includes("download") ||
    haystack.includes("file") ||
    haystack.includes("sandbox") ||
    haystack.includes(".zip") ||
    haystack.includes(".jsonl") ||
    haystack.includes(".json") ||
    haystack.includes(".csv") ||
    haystack.includes(".md") ||
    haystack.includes(".txt")
  );
}

async function clickSaveControl(timeoutMs = 5000) {
  const startedAt = Date.now();
  const selector = [
    "button",
    "a[href]",
    "[role='button']",
    "input[type='button']",
    "input[type='submit']"
  ].join(",");

  while (Date.now() - startedAt < timeoutMs) {
    const candidates = [...document.querySelectorAll(selector)]
      .filter(visible)
      .filter(looksLikeSaveControl);

    if (candidates.length) {
      const control = candidates[candidates.length - 1];
      console.info(DEBUG_PREFIX, "clicking save control", textOf(control));
      activate(control);
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return false;
}

async function downloadCandidate(candidate) {
  if (candidate.directDownload && /^https?:\/\//i.test(candidate.url || "")) {
    const response = await sendMessage({ type: "DOWNLOAD_FILE", file: candidate });
    if (response?.ok && !response.skipped) return true;
    if (response?.ok && response.skipped) {
      console.info(DEBUG_PREFIX, "download skipped by background", response.reason);
      return true;
    }

    console.warn(DEBUG_PREFIX, "background download failed, falling back to page click", response?.error);
  }

  const watch = await sendMessage({ type: "START_DOWNLOAD_WATCH", startedAt: Date.now() });
  activate(candidate.link);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await clickSaveControl();
  const response = await sendMessage({ type: "WAIT_DOWNLOAD_WATCH", watchId: watch?.watchId });
  if (!response?.ok) {
    throw new Error(response?.error || "Clicked download did not complete.");
  }
  return true;
}

function makeKey(link, label, messageIndex, linkIndex) {
  const href = link.href || "";
  const explicit = link.getAttribute?.("download") || "";
  return [href, explicit, label, messageIndex, linkIndex, document.location.pathname].join("|");
}

function latestFileCandidates() {
  const messages = getAssistantMessages();

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    const links = [...message.querySelectorAll("a[href]")].filter((link) => {
      return linkLooksDownloadable(link) || linkLooksSafeFallback(link);
    });
    if (!links.length) continue;

    return links.map((link, linkIndex) => {
      const label =
        (link.innerText || link.getAttribute("download") || link.getAttribute("aria-label") || "ChatGPT file").trim();

      return {
        url: link.href,
        label,
        key: makeKey(link, label, messageIndex, linkIndex),
        link,
        directDownload: true
      };
    });
  }

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    const controls = [...message.querySelectorAll("button, [role='button'], [tabindex]")]
      .filter(visible)
      .filter(looksLikeFileControl);
    if (!controls.length) continue;

    return controls.map((control, controlIndex) => {
      const label = textOf(control) || control.getAttribute("aria-label") || "ChatGPT file";

      return {
        url: control.href || "",
        label,
        key: makeKey(control, label, messageIndex, controlIndex),
        link: clickableFor(control),
        directDownload: false
      };
    });
  }

  return [];
}

function setComposerText(composer, text) {
  composer.focus();

  if (composer.tagName === "TEXTAREA") {
    composer.value = text;
    composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    return;
  }

  document.getSelection()?.selectAllChildren(composer);
  document.execCommand("insertText", false, text);
  composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
}

function findSendButton() {
  const selectors = [
    "#composer-submit-button",
    'button[aria-label*="Send prompt"]',
    'button[data-testid="send-button"]',
    'button[aria-label*="Send"]'
  ];

  for (const selector of selectors) {
    const button = document.querySelector(selector);
    if (visible(button) && !button.disabled) return button;
  }

  const composer = findComposer();
  const form = composer?.closest("form");
  return form ? [...form.querySelectorAll("button")].find((button) => visible(button) && !button.disabled) : null;
}

async function sendContinue(text) {
  const composer = findComposer();
  if (!composer) throw new Error("Message box was not found.");

  setComposerText(composer, text);
  await new Promise((resolve) => setTimeout(resolve, 250));

  const button = findSendButton();
  if (button) {
    button.click();
  } else {
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true })
    );
  }

  lastSentAt = Date.now();
}

async function tick() {
  if (isWorking) return;

  const state = await getState();
  if (state?.deleteNonProjectChatsEnabled) {
    await deleteNonProjectChatTick();
    return;
  }

  if (state?.enabled === false) return;
  if (Date.now() - lastSentAt < AFTER_SEND_COOLDOWN_MS) return;

  if (isGenerating()) {
    await sendMessage({ type: "STATUS", status: "Waiting for ChatGPT response" });
    return;
  }

  const candidates = latestFileCandidates();
  if (!candidates.length) {
    await sendMessage({ type: "STATUS", status: "Waiting for downloadable files in the latest message" });
    return;
  }

  const candidateBatchKey = candidates.map((candidate) => candidate.key).join("\n");
  if (candidateBatchKey === lastCandidateBatchKey) return;
  lastCandidateBatchKey = candidateBatchKey;

  isWorking = true;
  try {
    await sendMessage({ type: "STATUS", status: `Waiting for ${candidates.length} files to be ready` });
    await new Promise((resolve) => setTimeout(resolve, state.delayBeforeDownloadMs ?? 10000));

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      await sendMessage({
        type: "STATUS",
        status: `Downloading file (${index + 1}/${candidates.length}): ${candidate.label}`
      });
      console.info(DEBUG_PREFIX, "downloading file link", candidate.label, candidate.url);
      await downloadCandidate(candidate);
      await sendMessage({
        type: "MARK_DOWNLOADED",
        file: {
          key: candidate.key,
          label: candidate.label,
          url: candidate.url
        }
      });

      if (index < candidates.length - 1) {
        await sendMessage({
          type: "STATUS",
          status: `Waiting before next download (${index + 1}/${candidates.length})`
        });
        await new Promise((resolve) => setTimeout(resolve, state.delayBetweenDownloadsMs ?? 2000));
      }
    }

    await sendMessage({ type: "STATUS", status: "Waiting before sending continue" });
    await new Promise((resolve) => setTimeout(resolve, state.delayBetweenDownloadsMs ?? 2000));
    await sendMessage({ type: "STATUS", status: `Sending "${state.continueText}"` });
    await sendContinue(state.continueText || "continue");
    await sendMessage({ type: "STATUS", status: "Continue message sent" });
  } catch (error) {
    await sendMessage({ type: "STATUS", status: `Error: ${error.message}` });
  } finally {
    isWorking = false;
  }
}

setInterval(tick, LOOP_INTERVAL_MS);
