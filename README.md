# Icon Search Graph

## What this is

Workday Canvas Kit ships around 1,000 SVG icons ([`@workday/canvas-system-icons-web`](https://www.npmjs.com/package/@workday/canvas-system-icons-web)), each with a small set of best-guess metadata: a name, a category, and a handful of tags (about 5 on average). That's often not enough — someone looking for an icon usually thinks in terms of what it looks like or what it's for ("arrow pointing down", "settings gear"), not its internal name or its short tag list.

This project's goal is to make icons findable by natural language. The plan has five stages:

1. **Export** icons as images
2. **Tag generation** — use a vision-language model to look at each icon and generate richer, more associative tags (synonyms, related concepts, use cases)
3. **Staging & review** — check tag quality before committing anything
4. **ETL into a graph database** — Icon nodes, Tag nodes, Category nodes, connected up
5. **Natural-language search** against that graph (not yet scoped)

**Where things stand right now: stages 2, 4, and 5 are built.** Icons get tagged (stage 2), loaded into a [Neo4j](https://neo4j.com/) graph with vector + full-text search indexes (stage 4), and a hosted search server (stage 5) exposes hybrid natural-language search over that graph — both as MCP tools for AI assistants (Claude Code, Cursor, etc.) and as a plain REST API for a website's search box. Stages 1 and 3 exist only in ad hoc form so far (rasterization happens inline as part of tagging; review is just eyeballing the HTML report). See [MAINTAINING.md](./MAINTAINING.md) for how it actually works under the hood.

## How it works, in short

For each icon in the sample: read its SVG, render it to a PNG, send that image (plus the icon's existing name/category/tags as context) to a vision-language model running locally, ask it to generate richer tags/synonyms/use-cases, clean up the model's response (remove duplicates and low-value filler), and write everything to `output/tags.json` and a browsable `output/report.html`.

The model runs **locally** via [Ollama](https://ollama.com/) — no paid API calls — since cost matters at ~1,000-icon scale and these are simple, small icons that a modestly-sized open model can handle well.

## Prerequisites

- macOS on Apple Silicon (this was built and tested on a 16 GB Apple Silicon Mac)
- [Homebrew](https://brew.sh/) (used to install Ollama and Neo4j)
- [nvm](https://github.com/nvm-sh/nvm) (to get the right Node version — see `.nvmrc`)

You do **not** need to know Java to work with Neo4j here — you'll only ever touch it through Cypher (its query language) and the `neo4j-driver` npm package, both from this project's TypeScript code. Java is just the language Neo4j's server happens to be built in, the same way you don't need to know Go to run Ollama.

**The tagging results are already committed** (`output/tags.json`, ~800 icons' worth of vision-model output) — that's the one artifact expensive enough to be worth checking into git, so cloning this repo does *not* require re-running the multi-hour tagging step. Setup below is split accordingly: everyone needs the first part to search; the vision-language model is only needed if you actually want to (re)generate tags yourself.

## Setup

Needed to load the graph and run search:

```bash
# 1. Install and start Neo4j (the graph database)
brew install neo4j
brew services start neo4j

# 2. On first connection only, Neo4j requires changing the default password.
#    Pick your own password and swap it in below:
curl -u neo4j:neo4j -X POST http://localhost:7474/db/system/tx/commit \
  -H "Content-Type: application/json" \
  -d '{"statements":[{"statement":"ALTER CURRENT USER SET PASSWORD FROM $old TO $new","parameters":{"old":"neo4j","new":"YOUR-NEW-PASSWORD"}}]}'

# 3. Install and start Ollama (needed at search time too, for embedding live queries)
brew install ollama
brew services start ollama

# 4. Pull the embedding model used for semantic/similarity search (~274 MB)
ollama pull nomic-embed-text:v1.5

# 5. Use the right Node version for this project
nvm use

# 6. Install dependencies
npm install

# 7. Copy the env template and fill in the Neo4j password you set in step 2,
#    plus a value for MCP_API_KEY (any random string -- this is the bearer
#    token an MCP client must present; generate one with, e.g., `openssl rand -hex 24`)
cp .env.example .env
```

Once running, you can browse the graph visually at [http://localhost:7474](http://localhost:7474) (Neo4j Browser, bundled with the server — no separate install).

**Only needed if you plan to (re)generate tags yourself** (see "Regenerating or extending tags" below) — skip this if you're just running search against the committed data:

```bash
ollama pull qwen2.5vl:7b   # the vision-language model, ~6 GB
curl http://localhost:11434/api/tags   # confirm Ollama is responding
```

## Running it

The fast path — load the already-tagged data and start searching:

```bash
npm run load-graph      # reads output/tags.json, upserts into Neo4j, generates + stores embeddings
npm run search-server   # starts the MCP + REST search server
```

`load-graph` is safe to re-run any time — it only touches icons whose data actually changed, and running it again over unchanged icons doesn't create duplicates.

`search-server` serves two things from one process:
- `POST http://localhost:3000/mcp` — MCP tools (`search_icons_by_name`, `search_icons_by_category`, `search_icons_by_tag`, `search_icons_by_natural_language`, `get_icon_details`) for AI assistants. Requires a bearer token matching `MCP_API_KEY` from your `.env`. Example client config (e.g. for Claude Code):
  ```json
  { "mcpServers": { "canvas-icon-search": {
    "url": "http://localhost:3000/mcp",
    "headers": { "Authorization": "Bearer <your MCP_API_KEY>" }
  } } }
  ```
- `GET http://localhost:3000/api/search/{name,category,tag,natural-language}` and `GET /api/icons/:name` — plain JSON REST routes, unauthenticated, for a website's search box (e.g. `curl "http://localhost:3000/api/search/natural-language?query=arrow+pointing+down"`).

### Regenerating or extending tags (optional)

You don't need this to run search — it's only for actually changing what's tagged: picking up new icons after Canvas Kit ships more, or re-tagging after a prompt/model change (see `ollama pull qwen2.5vl:7b` under Setup above).

```bash
npm run tag        # small ~18-icon sample, a few minutes -- for testing prompt/code changes
npm run tag:all    # every active icon (822), several hours -- the real run
```

Both print progress as they go, and both save progress after every single icon (not just at the end) so an interrupted run can be safely resumed by just running the same command again — already-tagged icons are automatically skipped, so re-running either one only does work for icons that are new or previously failed. This means `tag:all` is also how you'd pick up newly-added icons later — it won't redo the ~800 already committed.

- `output/tags.json` — one record per icon: existing metadata, the model's generated tags, and some debugging info (raw model response, timestamps, any validation errors). Committed to the repo.
- `output/report.html` — open this in a browser to see each icon's image next to its old and new tags, side by side. Also committed.
- `output/images/` — the rasterized PNG sent to the model for each icon. *Not* committed (trivially regenerable from the SVGs already vendored in `node_modules`).

After regenerating tags, re-run `npm run load-graph` to push the changes into Neo4j.

Other useful commands:

```bash
npm run typecheck   # type-check the TypeScript source without running anything
```

## Project status / what's not built yet

- Deprecated icons (296 of them, which carry a `fallback` pointer to their replacement) aren't handled yet — only the 822 active icons are tagged, loaded, and searchable
- No staging/review workflow exists yet beyond eyeballing `output/report.html` — stage 3 is still just this README's description of the plan
- The search server's REST API has no rate-limiting yet — fine for local/internal use, a real gap before it's ever exposed on the public internet
- MCP auth is a static API key, not full OAuth 2.1 — a deliberate, documented starting point (see MAINTAINING.md), not an oversight

This README and [MAINTAINING.md](./MAINTAINING.md) will grow as the project evolves.
