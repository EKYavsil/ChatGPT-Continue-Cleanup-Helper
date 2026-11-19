const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { runInNewContext } = require("node:vm");

function loadScript(name, globals) {
  const source = readFileSync(resolve(__dirname, "..", name), "utf8");
  runInNewContext(source, globals, { filename: name });
}

function createPage(files, sentMessages, pageLanguage, sidebarChats) {
  const rect = () => ({ width: 120, height: 24, left: 0 });
  const links = files.map((name) => ({
    href: "https://files.example.invalid/" + name,
    innerText: name,
    hasAttribute: (attr) => attr === "download",
    getAttribute: (attr) => attr === "download" ? name : null
  }));
  const message = {
    getBoundingClientRect: rect,
    querySelectorAll: (selector) => selector === "a[href]" ? links : []
  };
  const composer = { tagName: "TEXTAREA", value: "", focus() {}, dispatchEvent() {} };
  const sendButton = {
    getBoundingClientRect: rect,
    click: () => sentMessages.push(composer.value)
  };
  const location = new URL("https://chat.example.invalid/c/sample");
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
    location, baseURI: location.href,
    documentElement: { lang: pageLanguage },
    querySelector(selector) {
      if (selector === "#prompt-textarea") return composer;
      if (selector === "#composer-submit-button") return sendButton;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "aside, nav, [role='navigation']") return [sidebar];
      return selector === '[data-message-author-role="assistant"]' ? [message] : [];
    }
  };
}

function createBrowser({
  settings = {}, files = [], conversations = [], listStatus = 200, pageLanguage = "en",
  sidebarChats = [], conversationDetails = {}
} = {}) {
  const storage = structuredClone(settings);
  const requests = [];
  const downloads = [];
  const sentMessages = [];
  const statuses = [];
  const downloadListeners = new Set();
  let receiveMessage;
  let runTick;

  const chrome = {
    runtime: {
      onInstalled: { addListener() {} },
      onMessage: { addListener(listener) { receiveMessage = listener; } },
      sendMessage(message, reply) {
        if (message.type === "STATUS") statuses.push(message.status);
        receiveMessage(message, {}, reply);
      }
    },
    storage: {
      local: {
        get(keys, reply) {
          const values = Array.isArray(keys) ? {} : { ...keys };
          for (const key of Array.isArray(keys) ? keys : Object.keys(keys)) {
            if (Object.hasOwn(storage, key)) values[key] = storage[key];
          }
          reply(structuredClone(values));
        },
        set(patch, done) { Object.assign(storage, structuredClone(patch)); done(); }
      }
    },
    downloads: {
      download(options, reply) {
        const id = downloads.length + 1;
        downloads.push({ id, url: options.url, state: "in_progress" });
        reply(id);
      },
      search({ id }, reply) { reply(downloads.filter((item) => item.id === id)); },
      onChanged: {
        addListener(listener) { downloadListeners.add(listener); },
        removeListener(listener) { downloadListeners.delete(listener); }
      }
    }
  };

  loadScript("background.js", {
    chrome, clearTimeout,
    setTimeout: (callback, delay) => setTimeout(callback, delay).unref()
  });
  const document = createPage(files, sentMessages, pageLanguage, sidebarChats);
  loadScript("content.js", {
    chrome, document, location: document.location, URL, URLSearchParams,
    window: { innerWidth: 1024, getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    InputEvent: class {},
    console: { info() {}, warn() {} },
    setInterval(callback) { runTick = callback; },
    setTimeout: queueMicrotask,
    async fetch(path, options = {}) {
      const url = new URL(path, document.location);
      const method = options.method || "GET";
      requests.push({ method, path: url.pathname, body: options.body });
      if (url.origin !== document.location.origin) throw new Error("Unexpected fetch origin");
      if (method === "GET" && url.pathname === "/api/auth/session") return Response.json({});
      if (method === "GET" && url.pathname === "/backend-api/conversations") {
        const offset = Number(url.searchParams.get("offset"));
        const limit = Number(url.searchParams.get("limit"));
        return Response.json({ items: conversations.slice(offset, offset + limit) }, { status: listStatus });
      }
      if (method === "PATCH" && url.pathname.startsWith("/backend-api/conversation/")) {
        return Response.json({});
      }
      if (method === "GET" && url.pathname.startsWith("/backend-api/conversation/")) {
        const id = decodeURIComponent(url.pathname.split("/").pop());
        return Object.hasOwn(conversationDetails, id)
          ? Response.json(conversationDetails[id])
          : Response.json({}, { status: 404 });
      }
      throw new Error("Unexpected fixture request: " + method + " " + url.pathname);
    }
  });

  function updateDownload(id, state) {
    const item = downloads.find((download) => download.id === id);
    if (!item) throw new Error("Unknown fixture download " + id);
    item.state = state;
    for (const listener of downloadListeners) listener({ id, state: { current: state } });
  }

  return {
    tick: runTick, storage, requests, downloads, sentMessages, statuses, updateDownload,
    send: (message) => new Promise((reply) => chrome.runtime.sendMessage(message, reply))
  };
}

module.exports = { createBrowser };
