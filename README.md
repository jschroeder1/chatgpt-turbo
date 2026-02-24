# ChatGPT Turbo

A browser extension that eliminates lag and freezing in long ChatGPT conversations.

## How it works

ChatGPT stores your entire conversation history and renders all of it every time the page loads. In long chats this causes significant UI lag — the browser is managing hundreds of DOM nodes even though you only care about the recent messages.

ChatGPT Turbo intercepts the conversation data before React renders it and trims it to the most recent N messages. Your full conversation context is unaffected — the AI always sees the complete history because that lives on OpenAI's servers, not in the browser's DOM.

## Installation

### Chrome / Edge
1. Go to `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer mode**
3. Click **Load unpacked** and select this folder

### Firefox
1. Go to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select the `manifest.json` file inside this folder

## Settings

Open the extension popup to configure:

- **Enabled** — toggle the extension on or off
- **Messages to show** — how many recent messages to render (default: 15). Lower values give a bigger speed boost.
- **Debug logging** — print activity to the DevTools console

If you need to see older messages, a **Load previous messages** button appears at the top of the chat when there are hidden messages. Each click loads one more batch.

## Notes

- No data is collected or transmitted. Everything runs locally in your browser.
- Not affiliated with OpenAI.

## License

MIT — see [LICENSE](LICENSE)
