# Extension test report

**33 of 33 automated tests passed** with Node.js 24.15.0 on Windows. Total runtime was 209.00 ms. The suite runs the content scripts and service worker with synthetic conversations, browser storage and download events.

| Scenario | Result | Time (ms) |
| --- | --- | ---: |
| Download mode leaves conversations alone when cleanup is disabled | Passed | 16.76 |
| Cleanup skips supported project markers and hides only the ordinary chat | Passed | 3.81 |
| A project-only API list and an empty sidebar produce no deletion | Passed | 3.24 |
| A rejected conversation list stops cleanup before any write | Passed | 2.43 |
| A project chat visible under Recent stays protected across cleanup ticks | Passed | 2.75 |
| Sidebar cleanup targets the verified ordinary ID when two chats share a title | Passed | 2.72 |
| Missing, ambiguous, mismatched or project details never authorize sidebar cleanup | Passed | 12.57 |
| Cleanup finishes scanning project pages before it checks the sidebar | Passed | 3.30 |
| Sidebar cleanup stops when the page language is unknown or non-English | Passed | 3.67 |
| Downloads every distinct file in order and confirms one follow-up | Passed | 9.00 |
| Only the current completed assistant reply is eligible | Passed | 13.25 |
| Inactive tabs do not fetch conversations | Passed | 3.23 |
| A worker restart resumes the same browser download | Passed | 3.90 |
| Interruptions can retry without repeating an earlier completed file | Passed | 3.89 |
| Turning Continue off during a download stops the batch | Passed | 2.57 |
| Leaving the chat or switching tabs before completion prevents a send | Passed | 6.98 |
| A user draft is preserved and the completed download can be reused | Passed | 3.15 |
| Missing send control preserves the empty composer and never clicks a fallback | Passed | 3.95 |
| A send button that becomes ready after the first poll sends once | Passed | 5.08 |
| Only the visible send action in the current composer is clicked | Passed | 3.45 |
| A send timeout retries the same completed file after the cooldown | Passed | 3.50 |
| An edit while waiting for the send button is preserved | Passed | 2.94 |
| An edit after reservation releases the unclicked send for a later retry | Passed | 3.36 |
| Hiding the conversation while waiting prevents a follow-up | Passed | 3.04 |
| An unconfirmed send remains reserved across tabs and reloads | Passed | 5.43 |
| Only a matching file delivery address can start a download | Passed | 6.20 |
| Size mismatch or an unexpected final URL pauses the reply | Passed | 4.61 |
| A different download finishing cannot advance the batch | Passed | 2.57 |
| A successful JSON error document cannot stand in for a text file of unknown size | Passed | 3.65 |
| A zero-byte file is valid when the resolver reports zero bytes | Passed | 2.71 |
| Rate limiting delays another request and leaves the composer untouched | Passed | 2.48 |
| A new reply before submission invalidates the previous batch | Passed | 2.51 |
| Concurrent tabs cannot start a second download or reserve a second send | Passed | 3.74 |

## Brave integration checks

Four runs loaded the unpacked extension in isolated Brave profiles using a local HTTPS fixture with two generated files. Each run verified that the downloaded bytes matched the two source files.

| Composer and scenario | Observed result |
| --- | --- |
| Textarea with the send button available immediately | One follow-up. Reloading the reply produced no additional download or message. |
| Contenteditable with a Turkish send button appearing after 850 ms | One follow-up. The voice, preview and out-of-form controls received zero clicks. |
| Send button appearing after the five-second wait expired | The extension reported the wait and sent once after the automatic retry. Each file was downloaded once. |
| User typed into the pending draft before the send button appeared | The edited text stayed in the composer. The reply remained eligible for a follow-up and no message was sent. |

## Run the automated suite

From the repository root, run the following command with Node.js 24.

```sh
node --test tests/extension.test.cjs
```
