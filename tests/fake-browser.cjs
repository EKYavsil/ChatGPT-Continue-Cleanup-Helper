const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const vm = require("node:vm");

function load(name, context) {
  vm.runInContext(readFileSync(resolve(__dirname, "..", name), "utf8"), context, { filename: name });
}

function createPage(sentMessages, pageLanguage, sidebarChats) {
  const rect = () => ({ width: 120, height: 24, left: 0 });
  const location = new URL("https://chatgpt.com/c/sample");
  const composer = Object.assign(new EventTarget(), {
    tagName: "TEXTAREA", value: "", focus() {}, closest() { return null; }, dispatchEvent() {}
  });
  const userRows = [];
  const sendButton = {
    dataset: { testid: "send-button" },
    matches(selector) { return selector.includes('button[data-testid="send-button"]'); },
    getBoundingClientRect: rect, getAttribute: () => null,
    click() {
      sentMessages.push(composer.value);
      userRows.push({ innerText: composer.value });
      composer.value = "";
    }
  };
  const row = {
    id: "reply-1", textContent: "Example", closest() { return this; },
    getAttribute(key) { return key === "data-message-id" ? this.id : "assistant"; }
  };
  const sidebarLinks = sidebarChats.map(({ id, title }) => ({
    href: new URL("/c/" + id, location).href,
    innerText: title,
    getBoundingClientRect: rect,
    getAttribute: (name) => name === "href" ? "/c/" + id : null,
    closest(selector) { return selector === "li" ? this : null; },
    contains(node) { return node === this; }
  }));
  const sidebar = {
    innerText: "Recent",
    getBoundingClientRect: rect,
    querySelectorAll(selector) {
      return selector.includes("a[href") || selector.includes("role='heading'") ? sidebarLinks : [];
    }
  };
  return {
    location, baseURI: location.href, composer, row, sendButton, visibilityState: "visible",
    addEventListener() {}, documentElement: { lang: pageLanguage },
    querySelector(selector) {
      if (selector === "#prompt-textarea") return composer;
      if (selector === "#composer-submit-button") return sendButton;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "aside, nav, [role='navigation']") return [sidebar];
      if (selector === "[data-message-author-role]") return [row];
      if (selector.includes('button[data-testid="send-button"]')) return [sendButton];
      if (selector.includes('="user"')) return userRows;
      return [];
    }
  };
}

function conversation(files, replyId = "reply-1") {
  return {
    current_node: replyId, conversation_id: "sample",
    messages: [{
      id: replyId, author: { role: "assistant" }, status: "finished_successfully", end_turn: true,
      metadata: { content_references: files.map((name, i) => ({ type: "file", name, id: "file_" + i })) }
    }]
  };
}

function createBrowser({
  settings = {}, files = [], conversations = [], listStatus = 200, pageLanguage = "en",
  sidebarChats = [], conversationDetails = {}, response = conversation(files), resolveFile
} = {}) {
  const storage = structuredClone(settings);
  const requests = [], downloads = [], sentMessages = [], statuses = [];
  const listeners = [];
  const locks = new Set();
  let receive, activeTab = 1;
  const pages = [];
  const wakeDelay = (resolve, ms) => [250, 750].includes(ms) ? setImmediate(resolve) : queueMicrotask(resolve);
  let clockOffset = 0;
  class TestDate extends Date {
    static now() { return Date.now() + clockOffset; }
  }
  const chrome = {
    runtime: { onInstalled: { addListener() {} }, getURL: path => "chrome-extension://fixture/" + path,
      onMessage: { addListener(fn) { receive = fn; } } },
    storage: {
      onChanged: { addListener(fn) { listeners.push(fn); } },
      local: {
        async get(keys) {
          if (keys === null) return structuredClone(storage);
          const names = typeof keys === "string" ? [keys] : Object.keys(keys);
          const out = typeof keys === "object" ? { ...keys } : {};
          for (const name of names) if (Object.hasOwn(storage, name)) out[name] = storage[name];
          return structuredClone(out);
        },
        async set(patch) {
          const changed = {};
          for (const [k, v] of Object.entries(patch)) if (storage[k] !== v) changed[k] = { newValue: v };
          Object.assign(storage, structuredClone(patch));
          if (patch.status) statuses.push(patch.status);
          listeners.forEach(fn => fn(changed, "local"));
        },
        async remove(keys) { keys.forEach(key => delete storage[key]); }
      }
    },
    tabs: { query: async () => [{ id: activeTab, url: pages[activeTab - 1]?.document.location.href }] },
    downloads: {
      async download(options) {
        const id = downloads.length + 1;
        downloads.push({ id, ...options, state: "in_progress", bytesReceived: 3 });
        return id;
      },
      async search({ id }) { return downloads.filter(item => item.id === id); }
    }
  };
  function restartWorker() {
    const ctx = vm.createContext({ chrome, URL, crypto });
    ctx.importScripts = name => load(name, ctx);
    load("background.js", ctx);
  }
  restartWorker();
  function openTab() {
    const id = pages.length + 1;
    const document = createPage(sentMessages, pageLanguage, sidebarChats);
    const sender = { tab: { id }, frameId: 0, url: document.location.href };
    const runtime = { ...chrome.runtime, sendMessage(message, cb) { receive(message, sender, cb); } };
    const tab = { document };
    pages.push(tab);
    const ctx = vm.createContext({
      chrome: { ...chrome, runtime }, document, location: document.location, URL, URLSearchParams, Date: TestDate,
      window: { innerWidth: 1024, addEventListener() {}, getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
      navigator: { locks: { async request(key, opts, fn) {
        if (locks.has(key)) return fn(null);
        locks.add(key);
        try { return await fn({}); } finally { locks.delete(key); }
      } } },
      InputEvent: class {}, MutationObserver: class { observe() {} },
      console: { info() {}, warn() {} }, setInterval(fn) { tab.tick = fn; },
      setTimeout(fn, ms) { if (ms !== 400) wakeDelay(fn, ms); return 1; },
      async fetch(path, options = {}) {
        const url = new URL(path, document.location);
        const method = options.method || "GET";
        requests.push({ method, path: url.pathname, body: options.body });
        if (url.origin !== document.location.origin) throw new Error("Unexpected fetch origin");
        if (url.pathname === "/api/auth/session") return Response.json({});
        if (method === "GET" && url.pathname === "/backend-api/conversations") {
          const offset = Number(url.searchParams.get("offset")), limit = Number(url.searchParams.get("limit"));
          return Response.json({ items: conversations.slice(offset, offset + limit) }, { status: listStatus });
        }
        if (method === "PATCH" && url.pathname.startsWith("/backend-api/conversation/")) return Response.json({});
        if (method === "GET" && url.pathname.startsWith("/backend-api/conversation/")) {
          const key = url.pathname.split("/").pop();
          return Object.hasOwn(conversationDetails, key) ? Response.json(conversationDetails[key]) : Response.json({}, { status: 404 });
        }
        if (url.pathname === "/backend-api/conversations/sample") return Response.json(response);
        if (url.pathname.startsWith("/backend-api/files/download/")) {
          const key = url.pathname.split("/").pop();
          if (resolveFile) return resolveFile(key);
          const ref = response.messages.flatMap(m => m.metadata?.content_references || []).find(f => f.id === key);
          return Response.json({ status: "success", file_name: ref.name, file_size_bytes: 3, mime_type: null,
            download_url: document.location.origin + "/backend-api/estuary/content?id=" + key + "&sig=fixture" });
        }
        throw new Error("Unexpected fixture request: " + method + " " + url.pathname);
      }
    });
    load("file-api.js", ctx);
    load("content.js", ctx);
    return tab;
  }
  const tab = openTab();
  return { ...tab, storage, requests, downloads, sentMessages, statuses, response, openTab, restartWorker,
    advanceTime(ms) { clockOffset += ms; },
    onStorageChange(listener) { listeners.push(listener); },
    activate(id) { activeTab = id; },
    updateDownload(id, state, bytes = 3) { Object.assign(downloads[id - 1], { state, bytesReceived: bytes }); },
    send: (message) => new Promise(resolve => receive(message, {}, resolve))
  };
}

module.exports = { createBrowser, conversation };
