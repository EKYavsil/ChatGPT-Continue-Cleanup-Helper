# ChatGPT File Continue & Cleanup Helper

A Chrome and Brave extension for ChatGPT conversations that produce files over several replies. It downloads files one at a time, waits for the batch to finish, then sends a follow-up message such as `continue`. A separate, optional mode cleans up conversations outside projects.

<p align="center">
  <img src="docs/assets/extension-preview.png" width="350" alt="Extension popup showing the download and cleanup switches, follow-up message, download folder, and timing settings.">
</p>

## Generating golden cards for a RAG system

I used the ChatGPT web interface to turn long, complex text files into “golden cards” for my retrieval-augmented generation (RAG) system. My goal was for each card to capture one idea from the source and keep enough context to make sense on its own.

ChatGPT produced the cards in batches across several replies. The extension downloaded each batch, then sent `continue` in the same conversation. That let me collect the full set of cards without having to save each file or prompt ChatGPT between batches.

## Install

1. Clone this repository or choose **Code → Download ZIP** on GitHub and extract the archive.
2. Open `chrome://extensions` in Chrome or `brave://extensions` in Brave. Enable **Developer mode**.
3. Choose **Load unpacked** and select the folder containing `manifest.json`.
4. Open or reload a ChatGPT conversation, then open the extension from the browser toolbar.

Both switches start off after installation or an extension update. Settings apply to the browser profile. Download mode operates in the active ChatGPT tab of the last focused window.

## Download files and continue

Turn on **ChatGPT Continue** in a conversation. The extension reads the file references on the latest completed assistant reply and requests a fresh delivery address for each file. Brave or Chrome saves the files in order. After verifying the downloads, the extension sends the configured follow-up in that conversation when the composer is empty. The popup shows progress and errors.

Completed files and the follow-up are tracked separately by conversation and reply. If the send button takes time to appear, the extension waits up to five seconds, then retries after 15 seconds while the conversation is active. It reuses completed downloads and preserves your edits to the draft.

Reloading the page resumes an unfinished batch. Switching tabs or turning the mode off pauses the next action. A download already started by the browser can finish. If the browser reports an interrupted transfer, turn Continue off and on to retry. If a send is unconfirmed, check the conversation and continue manually.

File discovery depends on the ChatGPT web application's conversation and file response formats. A change to those formats can pause a batch. Ordinary links in message text and preview buttons do not start downloads.

| Setting | Default | What it controls |
| --- | --- | --- |
| Continue text | `continue` | Message sent to the conversation after the batch finishes. |
| Download folder | `ChatGPT` | Subfolder under the browser’s downloads directory. |
| Delay before downloading | 10 seconds | Wait before resolving and downloading the files in a batch. |
| Delay between downloads | 2 seconds | Wait between files and before sending the follow-up message. |

## Clean up conversations

**Delete non-project chats** acts on the signed-in account’s conversation list, including chats other than the one currently open. While enabled, cleanup takes priority over downloads and processes one conversation at a time without asking you to confirm each one.

The extension remembers the IDs of project chats it encounters in the current tab and skips them on later passes. It asks ChatGPT to hide one eligible conversation by its ID. If the list has no eligible chat, the extension can check links in an English sidebar. It acts on a sidebar link only when ChatGPT returns the same conversation ID and explicitly reports no project membership. Chats with missing or conflicting details are skipped. Turn the switch off to stop further cleanup.

## Local data and privacy

Both modes use your signed-in ChatGPT session. The extension stores settings and status in the browser profile. Each processed reply has a local record containing conversation, reply, file and browser download IDs, expected size, format checks and follow-up state. Delivery URLs are used in memory. The browser maintains its own download history.

**Clear download history** turns off Continue and forgets processed replies. Enable it again only when you want files in the current reply to be eligible again. Existing files stay on disk. Updating from the older link-based implementation discards its URL-based history.

## Tests

From the repository root, run the automated tests with Node.js 24.

```sh
node --test tests/extension.test.cjs
```

The tests use simulated conversations and downloads to check cleanup, download order, duplicate detection and retries. [View the test report](tests/README.md).
