const test = require("node:test");
const assert = require("node:assert/strict");
const { setImmediate: nextTurn } = require("node:timers/promises");
const { createBrowser, conversation } = require("./fake-browser.cjs");

const cleanupOn = { deleteNonProjectChatsEnabled: true };
const downloadsOn = { enabled: true, continueText: "Next sample, please." };

test("Download mode leaves conversations alone when cleanup is disabled", async () => {
  const browser = createBrowser({
    settings: downloadsOn,
    conversations: [{ id: "sample-personal" }]
  });
  await browser.tick();
  assert.ok(browser.requests.every(request => request.method === "GET"));
  assert.match(browser.storage.status, /no generated files/i);
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

const job = browser => browser.storage["batch/sample/reply-1"];
const names = browser => browser.downloads.map(item => item.filename);
const start = async browser => {
  const done = browser.tick();
  await nextTurn();
  return { done };
};

test("Downloads every distinct file in order and confirms one follow-up", async () => {
  const b = createBrowser({ settings: downloadsOn, files: ["sample.csv", "sample.csv"] });
  const refs = b.response.messages[0].metadata.content_references;
  refs.push({ ...refs[0] });
  const { done } = await start(b);
  assert.deepEqual(names(b), ["ChatGPT/sample.csv"]);
  b.updateDownload(1, "complete");
  await nextTurn();
  assert.deepEqual(names(b), ["ChatGPT/sample.csv", "ChatGPT/sample.csv"]);
  assert.deepEqual(b.sentMessages, []);
  b.updateDownload(2, "complete");
  await done;
  assert.deepEqual(b.sentMessages, [downloadsOn.continueText]);
  assert.equal(job(b).followup, "sent");
  assert.doesNotMatch(JSON.stringify(b.storage), /sig=|estuary/);
  const other = b.openTab();
  b.activate(2);
  await other.tick();
  assert.equal(b.downloads.length, 2);
  assert.equal(b.sentMessages.length, 1);
});

test("Only the current completed assistant reply is eligible", async () => {
  for (const change of [
    r => { r.messages[0].id = "old"; }, r => { r.messages[0].author.role = "user"; },
    r => { r.messages[0].end_turn = false; }, r => { r.messages[0].status = "in_progress"; },
    r => { r.messages[0].metadata.content_references = []; },
    r => { r.messages[0].metadata.content_references[0].id = ""; },
    r => { r.conversation_id = "wrong"; }
  ]) {
    const r = conversation(["sample.txt"]);
    change(r);
    const b = createBrowser({ settings: downloadsOn, response: r });
    await b.tick();
    assert.equal(b.downloads.length, 0);
    assert.equal(b.sentMessages.length, 0);
  }
});

test("Inactive tabs do not fetch conversations", async () => {
  const b = createBrowser({ settings: downloadsOn, files: ["sample.txt"] });
  b.openTab();
  b.activate(2);
  await b.tick();
  assert.deepEqual(b.requests, []);
});

test("A worker restart resumes the same browser download", async () => {
  const b = createBrowser({ settings: downloadsOn, files: ["sample.txt"] });
  const { done } = await start(b);
  b.restartWorker();
  b.updateDownload(1, "complete");
  await done;
  assert.equal(b.downloads.length, 1);
  assert.equal(job(b).followup, "sent");
});

test("Interruptions can retry without repeating an earlier completed file", async () => {
  const b = createBrowser({ settings: downloadsOn, files: ["one.txt", "two.txt"] });
  const { done } = await start(b);
  b.updateDownload(1, "complete");
  await nextTurn();
  b.updateDownload(2, "interrupted");
  await done;
  assert.equal(job(b).files.file_1.state, "interrupted");
  await b.send({ type: "SET_STATE", patch: { enabled: false } });
  await b.send({ type: "SET_STATE", patch: { enabled: true } });
  const retry = await start(b);
  assert.deepEqual(names(b), ["ChatGPT/one.txt", "ChatGPT/two.txt", "ChatGPT/two.txt"]);
  b.updateDownload(3, "complete");
  await retry.done;
  assert.equal(job(b).followup, "sent");
});

test("Turning Continue off during a download stops the batch", async () => {
  const b = createBrowser({ settings: downloadsOn, files: ["one.txt", "two.txt"] });
  const { done } = await start(b);
  await b.send({ type: "SET_STATE", patch: { enabled: false } });
  b.updateDownload(1, "complete");
  await done;
  assert.equal(b.downloads.length, 1);
  assert.deepEqual(b.sentMessages, []);
});

test("Leaving the chat or switching tabs before completion prevents a send", async () => {
  for (const change of [b => { b.document.location.pathname = "/c/elsewhere"; }, b => { b.openTab(); b.activate(2); }]) {
    const b = createBrowser({ settings: downloadsOn, files: ["one.txt"] });
    const { done } = await start(b);
    change(b);
    b.updateDownload(1, "complete");
    await done;
    assert.deepEqual(b.sentMessages, []);
  }
});

test("A user draft is preserved and the completed download can be reused", async () => {
  const b = createBrowser({ settings: downloadsOn, files: ["sample.txt"] });
  b.document.composer.value = "My unfinished draft";
  const { done } = await start(b);
  b.updateDownload(1, "complete");
  await done;
  assert.equal(b.document.composer.value, "My unfinished draft");
  assert.deepEqual(b.sentMessages, []);
  b.document.composer.value = "";
  await b.tick();
  assert.equal(b.downloads.length, 1);
  assert.equal(job(b).followup, "sent");
});

test("Missing send control preserves the empty composer and never clicks a fallback", async () => {
  const b = createBrowser({ settings: downloadsOn, files: ["sample.txt"] });
  b.document.sendButton.disabled = true;
  const { done } = await start(b);
  b.updateDownload(1, "complete");
  await done;
  assert.equal(b.document.composer.value, "");
  assert.equal(job(b).followup, "ready");
  assert.deepEqual(b.sentMessages, []);
});

test("A send button that becomes ready after the first poll sends once", async () => {
  const b = createBrowser({ settings: downloadsOn, files: ["sample.txt"] });
  b.document.sendButton.disabled = true;
  const { done } = await start(b);
  b.updateDownload(1, "complete");
  await nextTurn();
  await nextTurn();
  assert.equal(b.document.composer.value, downloadsOn.continueText);
  assert.deepEqual(b.sentMessages, []);
  b.document.sendButton.disabled = false;
  await done;
  await b.tick();
  assert.deepEqual(b.sentMessages, [downloadsOn.continueText]);
  assert.equal(b.downloads.length, 1);
});

test("Only the visible send action in the current composer is clicked", async () => {
  const b = createBrowser({ settings: downloadsOn, files: ["sample.txt"] });
  const button = b.document.sendButton;
  const voice = {
    ...button,
    matches: selector => selector.includes("[data-composer-voice-start]"),
    click: () => assert.fail("Voice control was clicked")
  };
  const other = {
    ...button,
    matches: () => false,
    getAttribute: key => key === "aria-label" ? "Attach files" : null,
    click: () => assert.fail("Attachment control was clicked")
  };
  const send = {
    ...button,
    matches: () => false,
    getAttribute: key => key === "aria-label" ? "Mesajı gönder (Enter)" : null
  };
  const form = { querySelector: () => null, querySelectorAll: () => [voice, other, send] };
  b.document.composer.closest = () => form;
  button.click = () => assert.fail("A control outside the form was clicked");
  const { done } = await start(b);
  b.updateDownload(1, "complete");
  await done;
  assert.deepEqual(b.sentMessages, [downloadsOn.continueText]);
});

test("A send timeout retries the same completed file after the cooldown", async () => {
  const b = createBrowser({ settings: downloadsOn, files: ["sample.txt"] });
  b.document.sendButton.disabled = true;
  const { done } = await start(b);
  b.updateDownload(1, "complete");
  await done;
  assert.match(b.storage.status, /waiting for the send button/i);
  assert.equal(b.document.composer.value, "");
  b.document.sendButton.disabled = false;
  await b.tick();
  assert.deepEqual(b.sentMessages, []);
  b.advanceTime(16000);
  await b.tick();
  await b.tick();
  assert.deepEqual(b.sentMessages, [downloadsOn.continueText]);
  assert.equal(b.downloads.length, 1);
});

test("An edit while waiting for the send button is preserved", async () => {
  const b = createBrowser({ settings: downloadsOn, files: ["sample.txt"] });
  b.document.sendButton.disabled = true;
  const { done } = await start(b);
  b.updateDownload(1, "complete");
  await nextTurn();
  assert.equal(b.document.composer.value, downloadsOn.continueText);
  b.document.composer.value = "My draft";
  b.document.sendButton.disabled = false;
  await done;
  b.advanceTime(16000);
  await b.tick();
  assert.equal(b.document.composer.value, "My draft");
  assert.deepEqual(b.sentMessages, []);
  assert.equal(job(b).followup, "ready");
});

test("An edit after reservation releases the unclicked send for a later retry", async () => {
  const b = createBrowser({ settings: downloadsOn, files: ["sample.txt"] });
  let edited = false;
  b.onStorageChange(changes => {
    if (!edited && changes["batch/sample/reply-1"]?.newValue.followup === "reserved") {
      b.document.composer.value = "My edit";
      edited = true;
    }
  });
  const { done } = await start(b);
  b.updateDownload(1, "complete");
  await done;
  assert.equal(b.document.composer.value, "My edit");
  assert.equal(job(b).followup, "ready");
  assert.deepEqual(b.sentMessages, []);
  b.document.composer.value = "";
  b.advanceTime(16000);
  await b.tick();
  assert.deepEqual(b.sentMessages, [downloadsOn.continueText]);
  assert.equal(b.downloads.length, 1);
});

test("Hiding the conversation while waiting prevents a follow-up", async () => {
  const b = createBrowser({ settings: downloadsOn, files: ["sample.txt"] });
  b.document.sendButton.disabled = true;
  const { done } = await start(b);
  b.updateDownload(1, "complete");
  await nextTurn();
  b.document.visibilityState = "hidden";
  b.document.sendButton.disabled = false;
  await done;
  assert.equal(b.document.composer.value, "");
  assert.equal(job(b).followup, "ready");
  assert.deepEqual(b.sentMessages, []);
});

test("An unconfirmed send remains reserved across tabs and reloads", async () => {
  const b = createBrowser({ settings: downloadsOn, files: ["sample.txt"] });
  let clicks = 0;
  b.document.sendButton.click = () => { clicks++; };
  const { done } = await start(b);
  b.updateDownload(1, "complete");
  await done;
  assert.equal(job(b).followup, "reserved");
  const tab = b.openTab();
  b.activate(2);
  await tab.tick();
  assert.equal(clicks, 1);
  assert.deepEqual(b.sentMessages, []);
});

test("Only a matching file delivery address can start a download", async () => {
  for (const url of ["https://example.invalid/?", "/backend-api/files/download/file_0",
    "/backend-api/estuary/content?id=file_other"]) {
    const b = createBrowser({ settings: downloadsOn, files: ["sample.txt"], resolveFile: () => Response.json({
      status: "success", file_name: "sample.txt", download_url: url
    }) });
    await b.tick();
    assert.equal(b.downloads.length, 0);
    assert.equal(b.sentMessages.length, 0);
  }
});

test("Size mismatch or an unexpected final URL pauses the reply", async () => {
  for (const change of [item => { item.bytesReceived = 2; }, item => { item.finalUrl = "https://chatgpt.com/login"; }]) {
    const b = createBrowser({ settings: downloadsOn, files: ["one.txt"] });
    const { done } = await start(b);
    b.updateDownload(1, "complete");
    change(b.downloads[0]);
    await done;
    assert.equal(job(b).files.file_0.state, "unverified");
    assert.deepEqual(b.sentMessages, []);
  }
});

test("A different download finishing cannot advance the batch", async () => {
  const b = createBrowser({ settings: downloadsOn, files: ["sample.txt"] });
  const { done } = await start(b);
  b.downloads.push({ id: 99, state: "complete", bytesReceived: 3 });
  await nextTurn();
  assert.deepEqual(b.sentMessages, []);
  assert.equal(job(b).files.file_0.state, "in_progress");
  b.updateDownload(1, "complete");
  await done;
  assert.equal(job(b).followup, "sent");
});

test("A successful JSON error document cannot stand in for a text file of unknown size", async () => {
  const b = createBrowser({ settings: downloadsOn, files: ["sample.txt"], resolveFile: () => Response.json({
    status: "success", file_name: "sample.txt", file_size_bytes: null, mime_type: null,
    download_url: "/backend-api/estuary/content?id=file_0"
  }) });
  const { done } = await start(b);
  b.downloads[0].mime = "application/problem+json";
  b.updateDownload(1, "complete");
  await done;
  assert.equal(job(b).files.file_0.state, "unverified");
  assert.equal(b.sentMessages.length, 0);
});

test("A zero-byte file is valid when the resolver reports zero bytes", async () => {
  const b = createBrowser({ settings: downloadsOn, files: ["empty.txt"], resolveFile: () => Response.json({
    status: "success", file_name: "empty.txt", file_size_bytes: 0, mime_type: null,
    download_url: "/backend-api/estuary/content?id=file_0"
  }) });
  const { done } = await start(b);
  b.updateDownload(1, "complete", 0);
  await done;
  assert.equal(job(b).followup, "sent");
});

test("Rate limiting delays another request and leaves the composer untouched", async () => {
  const b = createBrowser({ settings: downloadsOn, files: ["sample.txt"],
    resolveFile: () => new Response("", { status: 429, headers: { "retry-after": "30" } }) });
  await b.tick();
  const count = b.requests.length;
  await b.tick();
  assert.equal(b.requests.length, count);
  assert.match(b.storage.status, /429/);
  assert.equal(b.sentMessages.length, 0);
});

test("A new reply before submission invalidates the previous batch", async () => {
  const b = createBrowser({ settings: downloadsOn, files: ["sample.txt"] });
  const { done } = await start(b);
  b.response.current_node = "newer-user-turn";
  b.updateDownload(1, "complete");
  await done;
  assert.equal(b.sentMessages.length, 0);
  assert.equal(job(b).followup, "ready");
});

test("Concurrent tabs cannot start a second download or reserve a second send", async () => {
  const b = createBrowser({ settings: downloadsOn, files: ["sample.txt"] });
  const other = b.openTab();
  const { done } = await start(b);
  b.activate(2);
  await other.tick();
  await done;
  const second = await start(other);
  assert.equal(b.downloads.length, 1);
  b.updateDownload(1, "complete");
  await second.done;
  assert.equal(b.sentMessages.length, 1);
});
