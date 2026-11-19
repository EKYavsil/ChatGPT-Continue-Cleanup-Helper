# Extension test report

**12 of 12 tests passed** · 0 failed · 0 skipped · 0 cancelled

Recorded with Node.js 24.15.0 against the v1.1.3 release sources. Total runtime was 95.97 ms.

| Scenario | Result | Time (ms) |
| --- | --- | ---: |
| Download mode leaves conversations alone when cleanup is disabled | Passed | 3.40 |
| Cleanup skips supported project markers and hides only the ordinary chat | Passed | 13.53 |
| A project-only API list and an empty sidebar produce no deletion | Passed | 2.21 |
| A rejected conversation list stops cleanup before any write | Passed | 1.94 |
| A project chat visible under Recent stays protected across cleanup ticks | Passed | 2.12 |
| Sidebar cleanup targets the verified ordinary ID when two chats share a title | Passed | 2.09 |
| Missing, ambiguous, mismatched or project details never authorize sidebar cleanup | Passed | 8.86 |
| Cleanup finishes scanning project pages before it checks the sidebar | Passed | 1.94 |
| Sidebar cleanup stops when the page language is unknown or non-English | Passed | 2.73 |
| Downloads complete in order before the configured continue message is sent | Passed | 5.52 |
| A completed file is skipped when its key is requested again | Passed | 1.60 |
| An interrupted download stays out of history and can be retried | Passed | 1.67 |

## Run the tests

From the repository root, run the suite with Node.js 24.

```sh
node --test tests/extension.test.cjs
```

The suite runs the extension's content script and background worker against a simulated chat page and an in-memory Chrome API. All conversations and downloads use synthetic data. Live browser rendering and ChatGPT service compatibility require separate browser testing.
