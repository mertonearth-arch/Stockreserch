# Jarvis

A general AI assistant you talk to. One page, `index.html`, published as a Claude artifact:

    https://claude.ai/artifact/PRpASpqwpoxxeMQSGGRB9M

It has nothing to do with the stock research in the rest of this repository and reads none
of its data.

## What it does

- **3D core** (three.js) that reacts to listening, thinking and speaking.
- **Talk and listen**: dictation in, read-aloud out, with a text field as the fallback.
- **Key-point popups**: decisions, facts, tasks, open questions and ideas from the
  conversation are pinned as cards around the core. "Destillera" re-reads the whole
  conversation and keeps the five most important.
- **Detail on every point**: each card has a number, a time and a longer explanation behind
  "mer"; every captured point also orbits the core as a satellite in the colour of its kind.
- **Conversation log** ("Samtal"): every line said, with its time.
- **Web**: inside the Claude desktop app it can search and read pages through the app's
  built-in browser.

The conversation and the points are kept in the browser's local storage only.

## Publishing

Artifact tool with `file_path: jarvis/index.html` and `url:` set to the link above. Omit
`capabilities` on a redeploy to keep the stored ones (`sample`, `dictation`, `tts`, and `mcp`
with `host:claude_browser`: `navigate`, `get_page_text`, `preview_start`).

## Limits

- The microphone needs a Chromium browser or the Claude desktop app.
- The web tools only work in the Claude desktop app, and only for the artifact's owner.
- The browser integration was written without access to a live browser and is unverified.
