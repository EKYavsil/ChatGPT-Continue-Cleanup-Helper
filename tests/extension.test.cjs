const test = require("node:test");
const assert = require("node:assert/strict");
const { setImmediate: nextTurn } = require("node:timers/promises");
const { createBrowser } = require("./fake-browser.cjs");

const cleanupOn = { deleteNonProjectChatsEnabled: true };
const downloadsOn = { enabled: true, continueText: "Next sample, please." };

test("Download mode leaves conversations alone when cleanup is disabled", async () => {
  const browser = createBrowser({
    settings: downloadsOn,
    conversations: [{ id: "sample-personal" }]
  });
  await browser.tick();
  assert.deepEqual(browser.requests, []);
  assert.match(browser.storage.status, /waiting for downloadable files/i);
});

test("Cleanup skips supported project markers and hides only the ordinary chat", async () => {
  const markers = [
    { project_id: "sample" }, { projectId: "sample" }, { project: { id: "sample" } },
    { workspace_project_id: "sample" }, { current_project_id: "sample" },
    { conversation_origin: { project_id: "sample" } },
    { metadata: { project_id: "sample" } }, { metadata: { projectId: "sample" } }
  ];
  const conversations = markers.map((marker, i) => ({ id: "project-chat-" + i, ...marker }));
  conversations.push({ id: "ordinary-chat", title: "Sample notes" });
  const browser = createBrowser({ settings: cleanupOn, conversations });
  await browser.tick();
  const writes = browser.requests.filter((request) => request.method !== "GET");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, "PATCH");
  assert.equal(writes[0].path, "/backend-api/conversation/ordinary-chat");
  assert.deepEqual(JSON.parse(writes[0].body), { is_visible: false });
});

test("A project-only API list and an empty sidebar produce no deletion", async () => {
  const browser = createBrowser({
    settings: cleanupOn,
    conversations: [{ id: "protected-chat", project_id: "sample-project" }]
  });
  await browser.tick();
  assert.ok(browser.requests.some((request) => request.path === "/backend-api/conversations"));
  assert.ok(browser.requests.every((request) => request.method === "GET"));
  assert.equal(browser.storage.status, "No chat found");
});

test("A rejected conversation list stops cleanup before any write", async () => {
  const browser = createBrowser({ settings: cleanupOn, listStatus: 403 });
  await browser.tick();
  assert.match(browser.storage.status, /list API error: 403/i);
  assert.ok(browser.requests.every((request) => request.method === "GET"));
});

test("A project chat visible under Recent stays protected across cleanup ticks", async () => {
  const chat = { id: "protected-chat", title: "Quarterly planning" };
  const conversations = [{ ...chat, project_id: "sample-project" }];
  const browser = createBrowser({
    settings: cleanupOn, conversations, sidebarChats: [chat],
    conversationDetails: { [chat.id]: { ...chat, project_id: null } }
  });
  await browser.tick();
  conversations.length = 0;
  await browser.tick();
  assert.ok(browser.requests.every((request) => request.method === "GET"));
  assert.ok(browser.requests.every((request) => !request.path.endsWith("/" + chat.id)));
  assert.deepEqual(browser.statuses.filter((status) => /^deleting|^deleted/i.test(status)), []);
  assert.equal(browser.storage.status, "No chat found");
});

test("Sidebar cleanup targets the verified ordinary ID when two chats share a title", async () => {
  const project = { id: "project-chat", title: "Weekly notes" };
  const ordinary = { id: "ordinary-chat", title: "Weekly notes" };
  const browser = createBrowser({
    settings: cleanupOn, conversations: [{ ...project, metadata: { projectId: "sample" } }],
    sidebarChats: [project, ordinary], conversationDetails: { [ordinary.id]: { ...ordinary, project_id: null } }
  });
  await browser.tick();
  const details = browser.requests.filter((item) => item.path.startsWith("/backend-api/conversation/"));
  assert.deepEqual(details.map(({ method, path }) => [method, path]), [
    ["GET", "/backend-api/conversation/ordinary-chat"],
    ["PATCH", "/backend-api/conversation/ordinary-chat"]
  ]);
  assert.deepEqual(JSON.parse(details[1].body), { is_visible: false });
});

test("Missing, ambiguous, mismatched or project details never authorize sidebar cleanup", async () => {
  const responses = [
    null, {}, { id: "sidebar-chat" }, { id: "other-chat", project_id: null },
    { id: "sidebar-chat", conversation_id: "other-chat", project_id: null },
    { id: "sidebar-chat", project_id: null, metadata: { projectId: "sample" } }
  ];
  for (const details of responses) {
    const chat = { id: "sidebar-chat", title: "Sample notes" };
    const browser = createBrowser({
      settings: cleanupOn, sidebarChats: [chat], conversationDetails: details ? { [chat.id]: details } : {}
    });
    await browser.tick();
    assert.ok(browser.requests.some((request) => request.path === "/backend-api/conversation/sidebar-chat"));
    assert.ok(browser.requests.every((request) => request.method === "GET"));
    assert.deepEqual(browser.statuses.filter((status) => /^deleting|^deleted/i.test(status)), []);
  }
});

test("Cleanup finishes scanning project pages before it checks the sidebar", async () => {
  const conversations = Array.from({ length: 251 }, (_, i) => ({
    conversation_id: "chat-" + i, project_id: "sample-project"
  }));
  const browser = createBrowser({
    settings: cleanupOn, conversations,
    sidebarChats: [{ id: "chat-250", title: "Last project chat" }],
    conversationDetails: { "chat-250": { id: "chat-250", project_id: null } }
  });
  await browser.tick();
  await browser.tick();
  assert.ok(browser.requests.every((request) => request.method === "GET"));
  assert.ok(browser.requests.every((request) => !request.path.endsWith("/chat-250")));
  assert.equal(browser.storage.status, "No chat found");
});

test("Sidebar cleanup stops when the page language is unknown or non-English", async () => {
  for (const pageLanguage of ["", "tr"]) {
    const browser = createBrowser({ settings: cleanupOn, pageLanguage });
    await browser.tick();
    assert.ok(browser.requests.some((request) => request.path === "/backend-api/conversations"));
    assert.ok(browser.requests.every((request) => request.method === "GET"));
    assert.match(browser.storage.status, /sidebar cleanup requires an English interface/i);
  }
});

test("Downloads complete in order before the configured continue message is sent", async () => {
  const browser = createBrowser({ settings: downloadsOn, files: ["first.csv", "second.csv"] });
  const tick = browser.tick();
  await nextTurn();
  assert.deepEqual(browser.downloads.map((item) => item.url), ["https://files.example.invalid/first.csv"]);
  assert.deepEqual(browser.sentMessages, []);

  browser.updateDownload(1, "complete");
  await nextTurn();
  assert.deepEqual(browser.downloads.map((item) => item.url), [
    "https://files.example.invalid/first.csv", "https://files.example.invalid/second.csv"
  ]);
  assert.deepEqual(browser.sentMessages, []);

  browser.updateDownload(2, "complete");
  await tick;
  assert.deepEqual(browser.sentMessages, [downloadsOn.continueText]);
});

const file = { key: "sample-file", label: "sample.csv", url: "https://files.example.invalid/sample.csv" };

test("A completed file is skipped when its key is requested again", async () => {
  const browser = createBrowser();
  const request = { type: "DOWNLOAD_FILE", file };
  const pending = browser.send(request);
  await nextTurn();
  browser.updateDownload(1, "complete");
  assert.equal((await pending).ok, true);
  const repeated = browser.send(request);
  await nextTurn();
  assert.equal(browser.downloads.length, 1);
  assert.equal((await repeated).skipped, true);
});

test("An interrupted download stays out of history and can be retried", async () => {
  const browser = createBrowser();
  const request = { type: "DOWNLOAD_FILE", file };
  const pending = browser.send(request);
  await nextTurn();
  browser.updateDownload(1, "interrupted");
  const failure = await pending;
  assert.equal(failure.ok, false);
  assert.match(failure.error, /interrupted/i);
  assert.deepEqual(Array.from((await browser.send({ type: "GET_STATE" })).downloadedKeys), []);

  const retry = browser.send(request);
  await nextTurn();
  browser.updateDownload(2, "complete");
  assert.equal((await retry).ok, true);
  assert.equal(browser.downloads.length, 2);
});
