const ChatFiles = (() => {
  const validId = (value) => typeof value === "string" && /^[a-z0-9_-]{1,160}$/i.test(value);
  const validFileId = (value) => validId(value) && /^file[-_]/i.test(value);

  function conversationId(path) {
    return path.match(/^(?:\/g\/[^/]+)?\/c\/([a-z0-9_-]{1,160})\/?$/i)?.[1] || "";
  }

  function contentURL(address, origin, fileId) {
    const url = new URL(address, origin);
    if (url.origin !== origin || url.protocol !== "https:" || url.username || url.password ||
        url.pathname !== "/backend-api/estuary/content" || url.searchParams.get("id") !== fileId) {
      throw new Error("Unrecognized file delivery address.");
    }
    return url.href;
  }

  async function read(path, request) {
    const response = await request(path);
    if (!response.ok) {
      const error = new Error(`File API returned HTTP ${response.status}.`);
      if (response.status === 429) error.retryMs = retryDelayFromResponse(response);
      throw error;
    }
    return response.json();
  }

  async function latest(id, request) {
    const data = await read(`/backend-api/conversations/${id}?num_turns=10&include_has_versions=true`, request);
    if (data?.conversation_id !== id || !Array.isArray(data.messages) || !validId(data.current_node)) {
      throw new Error("Unrecognized conversation response.");
    }
    const message = data.messages.find((entry) => entry.id === data.current_node);
    if (!message || message.author?.role !== "assistant" || message.status !== "finished_successfully" ||
        message.end_turn !== true || message.metadata?.is_visually_hidden_from_conversation) return null;

    const refs = message.metadata?.content_references ?? [];
    if (!Array.isArray(refs)) throw new Error("Unrecognized file references.");
    const files = new Map();
    for (const ref of refs) {
      if (ref?.type !== "file") continue;
      if (!validFileId(ref.id) || typeof ref.name !== "string" || !ref.name.trim()) {
        throw new Error("A file reference is incomplete.");
      }
      files.set(ref.id, { id: ref.id, name: ref.name });
    }
    return { conversationId: id, replyId: message.id, files: [...files.values()] };
  }

  async function resolve(file, origin, request) {
    const info = await read(`/backend-api/files/download/${file.id}?download_intent=true`, request);
    if (info?.status !== "success" || info.file_name !== file.name || typeof info.download_url !== "string") {
      throw new Error("The file is not available for download.");
    }
    const size = info.file_size_bytes ?? null;
    if (size !== null && (!Number.isSafeInteger(size) || size < 0)) throw new Error("Invalid file size.");
    return { url: contentURL(info.download_url, origin, file.id), size, mime: info.mime_type || "" };
  }

  return { conversationId, validId, validFileId, contentURL, latest, resolve };
})();
