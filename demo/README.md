# Icon Search Demo

A small React app for showing off natural-language icon search — the same feature exposed via REST/MCP in the main project, with a real search box and results grid instead of `curl`. Built with [Canvas Kit React](https://www.npmjs.com/package/@workday/canvas-kit-react) so it actually looks like it belongs next to the rest of Canvas.

This is a demo prop, not a production app: no build/deploy pipeline, no error boundaries, nothing fancier than "type a query, see icon results." It calls the search server directly from the browser — nothing about it needs to be deployed anywhere for it to work.

## Running it

From the **project root** (not this directory), make sure the search server is up first:

```bash
npm run search-server
```

Then, from this directory:

```bash
npm install
cp .env.example .env
npm run dev
```

Open the URL Vite prints (`http://localhost:5173` by default). If search requests fail, the search server almost certainly isn't running, or Neo4j/Ollama aren't up underneath it — see the project root's [README](../README.md) for the full setup checklist.

## What it's showing

Only the natural-language search mode — on purpose. This is the one mode that finds an icon from a plain description without needing to already know its name, category, or exact tag, which is exactly where it should look better than the current keyword-only search on [canvas.workday.com](https://canvas.workday.com/styles/assets/system-icons#tab=gallery). A few starter queries are built in as clickable examples, chosen because they don't share exact words with the icons they should find.

## How it's built

- `src/api.ts` — calls `GET /api/search/natural-language` on the search server (see `../src/server/restRoutes.ts`) and builds icon image URLs from the server's `/images/*` static route (see `../src/server/index.ts`).
- `src/SearchDemo.tsx` — the search box (Canvas Kit `InputGroup` + `TextInput`) and results grid (`Card` per icon, showing the actual rasterized PNG, name, category, and description).
- Icon images are the same PNGs the tagging pipeline already produced (`output/images/*.png`) — this app doesn't generate or store its own copies, just displays what the search server serves.
