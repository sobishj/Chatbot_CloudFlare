# Website Assistant (Cloudflare edition)

An AI chat assistant that any organisation (malls, hotels, hospitals, universities, airports,
restaurants, dealerships, real estate, government sites) can add to its website with **one
script line**. It answers visitors' questions from the client's **website** and **documents**,
in the visitor's language, and logs every question for analytics.

This edition runs entirely on **Cloudflare's free plan**: one Worker, D1, Vectorize, Workers AI
and Workers KV, with cloud LLMs through API keys (no R2 bucket needed). The self-hosted edition
(Python, PostgreSQL, Docker, local models) is [github.com/sobishj/Chatbot](https://github.com/sobishj/Chatbot); see
[Features that need the self-hosted version](#features-that-need-the-self-hosted-version).

Everything is managed in a web admin UI. The terminal is needed once, to deploy.

```
 visitor's browser                         Cloudflare
┌───────────────────┐   widget.js    ┌───────────────────────────────────────────────┐
│ client website    │ ─────────────▶ │ Worker   public chat API + widget.js           │
│  <script …>       │ ◀───────────── │          admin UI (React) + admin API          │
└───────────────────┘   /api/chat    │          cron: crawls, indexing, scheduler     │
                                     │ D1       data + full-text search (FTS5)        │
                                     │ Vectorize  vectors   ·  Workers KV  files      │
                                     │ Workers AI  embeddings (bge-m3), PDF/Office    │
                                     └──────────────┬────────────────────────────────┘
                                                    │ fetch
                                   any cloud LLM: OpenAI, Claude, Gemini, Kimi, DeepSeek,
                                   Mistral, Groq, OpenRouter, DeepInfra, OpenAI-compatible
```

**How an answer is made:** the question is masked (phone numbers and emails removed). Then
hybrid search runs: Vectorize similarity plus D1 full-text search (FTS5), merged with reciprocal
rank fusion and always filtered by client. The model gets the top 6 passages plus the last 4
messages of the conversation. Visitors get the answer only (no source links or document names);
it is logged with its sources. Answers with low confidence are marked *unanswered* so they show
up in Stats.

---

## Contents

1. [Requirements](#1-requirements)
2. [Install (deploy to Cloudflare)](#2-install-deploy-to-cloudflare)
3. [Setup wizard](#3-setup-wizard)
4. [Adding a client](#4-adding-a-client)
5. [Website crawling](#5-website-crawling)
6. [Documents](#6-documents)
7. [AI models](#7-ai-models)
8. [API actions (optional)](#8-api-actions-optional)
9. [Embedding the widget](#9-embedding-the-widget)
10. [Users and roles](#10-users-and-roles)
11. [Cloud vs on-premise](#11-cloud-vs-on-premise)
12. [HTTPS and custom domains](#12-https-and-custom-domains)
13. [Backups and restore](#13-backups-and-restore)
14. [Command line (developers and recovery)](#14-command-line-developers-and-recovery)
15. [Development and tests](#15-development-and-tests)
16. [Configuration reference](#16-configuration-reference)
17. [Troubleshooting](#17-troubleshooting)
18. [Free plan limits](#free-plan-limits)
19. [Features that need the self-hosted version](#features-that-need-the-self-hosted-version)

---

## 1. Requirements

| | Needed |
|---|---|
| Cloudflare | A free account (Workers Free plan) |
| Your computer | Node.js 20+ and npm, to build the admin UI and deploy (Windows, macOS or Linux) |
| AI model | An API key for at least one cloud model provider (OpenAI, Anthropic, Google, DeepInfra, …) |

No server, database or GPU is needed: Cloudflare runs everything. Embeddings use Workers AI
(`@cf/baai/bge-m3`, multilingual) from its free daily allowance.

## 2. Install (deploy to Cloudflare)

```bash
git clone https://github.com/sobishj/Chatbot_CloudFlare.git website-assistant
cd website-assistant/worker
npm install
```

1. **Sign in to Cloudflare** (opens the browser once):
   ```bash
   npx wrangler login
   ```
2. **Create the database** and paste the `database_id` it prints into `wrangler.jsonc`
   (`d1_databases[0].database_id`):
   ```bash
   npx wrangler d1 create website-assistant
   ```
3. **Create the vector index** (1024 dimensions, the size of bge-m3 vectors):
   ```bash
   npx wrangler vectorize create chunks --dimensions=1024 --metric=cosine
   ```
4. **Create the file store** (uploaded documents and logos) and paste the `id` it prints into
   `wrangler.jsonc` (`kv_namespaces[0].id`, in place of `PASTE_YOUR_KV_NAMESPACE_ID_HERE`):
   ```bash
   npx wrangler kv namespace create FILES_KV
   ```
5. **Set the secret key** (a long random string, 32+ characters):
   ```bash
   npx wrangler secret put SECRET_KEY
   ```
   > **Never change or lose `SECRET_KEY`** after setup. It encrypts the saved API keys and signs
   > sessions. Keep a copy somewhere safe (a password manager).
6. **Create the tables**:
   ```bash
   npx wrangler d1 migrations apply website-assistant --remote
   ```
7. **Build the admin UI** (`frontend/` into `frontend/dist`, plus `widget.js`):
   ```bash
   npm run build
   ```
8. **Deploy**:
   ```bash
   npx wrangler deploy
   ```
   It prints the Worker's address, e.g. `https://website-assistant.<you>.workers.dev`.
   Open `https://website-assistant.<you>.workers.dev/setup` to finish setup.
9. **Add a custom domain** (recommended, e.g. `chat.example.com`): Cloudflare dashboard →
   Workers & Pages → *website-assistant* → Settings → **Domains & Routes** → *Add* → *Custom
   domain*. The domain must be on a zone in your Cloudflare account; Cloudflare issues the
   certificate. See [section 12](#12-https-and-custom-domains) for a separate admin host name.

`npm run deploy` does steps 7 and 8 together. Running the steps again is safe; migrations are
applied only once.

### Embedding models: Workers AI or cloud

**Settings → Embeddings** lists the models with their languages, the time for 1,000 pages
(measured once something has been indexed) and, for cloud models, the cost:

| Model | Where | Notes |
|---|---|---|
| `@cf/baai/bge-m3` (default) | Cloudflare Workers AI | BGE-M3, 100+ languages; ready at once, free daily allowance |
| OpenAI `text-embedding-3-small` | Cloud | ~$0.02 per 1M tokens, requested at 1024 dimensions |
| OpenAI `text-embedding-3-large` | Cloud | Most accurate OpenAI model, requested at 1024 dimensions |
| Google `gemini-embedding-001` | Cloud | Strong multilingual quality, free tier with rate limits, 1024 dimensions |
| Mistral `mistral-embed` | Cloud | Inexpensive, best for European languages (1024 dimensions) |
| `BAAI/bge-m3`, `intfloat/multilingual-e5-small`, `BAAI/bge-small-en-v1.5` | Local | Listed, but [need the self-hosted version](#features-that-need-the-self-hosted-version) |

Cloud models need an API key (leave it blank to reuse the key of a saved AI model from the same
provider) and send document text and visitor questions to the provider. Switching models
re-indexes all content once.

When an upload would take the current model more than about 10 minutes, it isn't indexed right
away: the Documents tab shows the estimate next to each cloud model's time and cost, and the
admin chooses to index anyway or switch models.

## 3. Setup wizard

Open `https://<your-worker-address>/setup`. The wizard is available only until setup is completed.

1. **Super admin account**: name, email and password (at least 10 characters).
2. **Mode**: *Cloud* (many clients) or *On-premise* (one client). See [section 11](#11-cloud-vs-on-premise).
3. **Public domain**: the address websites load the widget from, e.g. `chat.example.com`
   (no `https://`). For local testing you can use `localhost:8787`.
4. **First AI model**: pick a provider, then fill in the URL, model name and API key.
   **Test connection** must succeed before you can continue.
5. **Embedding model**: `@cf/baai/bge-m3` (Workers AI) is already ready; press **Continue**.
6. **Client** (on-premise only): the single organisation this installation serves.
7. **Done**: opens the dashboard.

## 4. Adding a client

Go to **Clients → Add client** and fill in:
- **Name**
- **Client ID**: lowercase letters, digits and hyphens, e.g. `lulu-kochi`. It appears in the
  embed code and can't be changed later.
- **Website URL**
- **Allowed domains**: the websites allowed to show the widget. Defaults to the website's
  domain.

The client detail page has these tabs:

| Tab | What it does |
|---|---|
| Overview | Counts, running jobs, activate/deactivate, delete |
| Website | **Crawl now** with live progress, crawl settings, crawled pages (view the exact text learned, remove a page) |
| Documents | Drag-and-drop upload, Use checkboxes, key information, re-index |
| AI model | Which saved model answers this client (default = system default) |
| Branding | Colour, logo, bot name, greeting, language, position, "Powered by", **live preview** |
| Allowed domains | Websites allowed to use this bot (super admin only) |
| Test chat | Chat as a visitor, with confidence score, model used, response time and the retrieved passages |
| Embed code | The one-line script with a Copy button, plus guides for WordPress, Wix, Shopify, Squarespace, GTM and custom HTML |
| Stats | Questions over 7/30/90 days, top 20 questions, unanswered questions, per-day chart, languages, tokens and cost |
| Conversations | Searchable question/answer log (personal data masked), CSV export |

**Chatbot on/off.** The switch at the top of a client's **Overview** tab turns the chatbot on the
website on or off. While it is off, the chat bubble doesn't appear and the public chat API
refuses messages; **Test chat** keeps working, and nothing else changes (content, settings, crawls).

Deleting a client also deletes its vectors (Vectorize) and files (Workers KV).

## 5. Website crawling

**Crawl now** (Website tab) queues a crawl job:

- Reads `robots.txt`, respecting `Disallow`, `Crawl-delay` and its `Sitemap:` entries.
- Tries sitemaps first (`/sitemap.xml`, `/sitemap_index.xml`, `/wp-sitemap.xml`, including
  index files and `.gz`). If there are none, it follows internal links from the start page.
- Stays on the same site (`www.` and the bare domain count as the same site), waits a delay
  between requests and stops at the page limit.
- **Text extraction:**
  - *Full page content* (default) removes the header, menus, footer, scripts and forms and
    keeps everything else, including small facts such as "Located on: Second Floor" or
    opening hours.
  - *Main article only* keeps the page's main block (its `<article>`, `<main>`, or the block
    with the most paragraph text) and suits blogs and news sites.
- Unchanged pages (same content hash) are skipped. Changed pages are re-indexed. Pages that
  disappeared (404/410, or no longer found after a complete crawl) are removed along with
  their passages and vectors.
- **Include/exclude patterns** are wildcards matched against the URL path, e.g. `/shop/*`
  or `*?print=*`.

**How jobs run on Cloudflare.** A Worker invocation may use only a few milliseconds of CPU, so a
crawl or a large document is processed in small steps: a page or a batch of passages at a time.
Each step saves its position, so jobs continue where they stopped. While the job's progress is
open in the admin UI, every progress check advances it; otherwise the per-minute scheduler does,
so jobs also finish with the browser closed (more slowly). Cancel and Retry work as before.

Automatic re-crawls run daily or weekly at a time you choose (Settings → Crawl schedule).
They re-crawl every active client and re-check their documents.

## 6. Documents

Supported formats: **PDF, DOCX, XLSX, TXT, MD**, up to **25 MB** each (the largest value Workers
KV stores). A larger file is refused with *"File is larger than 25 MB…"*; split or compress it. PDF, Word and Excel files are converted with Workers AI
(`toMarkdown`); text and Markdown files are read directly. Scanned PDFs (images without a text
layer) can't be read here: they are marked *"No text found: this looks like a scanned PDF."*
(the self-hosted version reads them with OCR).

**Upload**: drag files into the Documents tab. They're stored in Workers KV (under
`clients/<client>/documents/<file name>`) and indexed automatically. The extracted text is kept,
so re-indexing doesn't convert the file again.

Workers KV is *eventually consistent*: a file you just replaced can take up to about a minute to
reach every Cloudflare location. Each upload's SHA-256 is saved in D1, and the indexer checks the
file it reads against it; if it gets an older copy (or none yet), it waits 15 seconds and tries
again, for up to about 3 minutes, before marking the document with an error.

Indexing runs as a background job, so it carries on when you leave the Documents tab or close
the browser; the tab shows the progress again when you come back. A large document is built
up in the background and replaces the old version only when it is complete, so search never
sees a half-indexed document. A document deleted while it is being indexed is skipped, and the
rest of the job continues.

**Use / ignore a document.** Each document has a **Use** checkbox (ticked by default); the box
in the column header ticks or unticks all of them at once. The assistant answers from every
ticked document, whatever its subject (for example a manual for another product or a letter),
and never from unticked ones. Unticked documents stay indexed, so ticking them again is instant.

**Key information** (Documents → Answering) is always given to the assistant, whatever search
finds: put the business's opening hours, address and contact details there.

**Watched folders** need the self-hosted version: saving a folder path or **Scan now** answers
with a message saying so.

## 7. AI models

**Settings → AI models → Add model.** Calls go straight to each provider's API, so you can add
or switch models without deploying anything.

| Provider | Base URL (pre-filled) | Example model |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Anthropic (Claude) | `https://api.anthropic.com` | `claude-haiku-5-5` (fast) or `claude-sonnet-5-5` |
| Google (Gemini) | `https://generativelanguage.googleapis.com` | `gemini-3.5-flash` |
| Moonshot (Kimi) | `https://api.moonshot.ai/v1` | `kimi-k2-0905-preview` |
| DeepSeek / Mistral / Groq / OpenRouter | pre-filled | see the provider's docs |
| DeepInfra (Qwen, Llama and other open models, no GPU needed) | `https://api.deepinfra.com/v1/openai` | `Qwen/Qwen3-235B-A22B-Instruct-2507` |
| Other OpenAI-compatible server | its public `https://…/v1` address | e.g. `qwen2.5-7b-instruct` |

- **Test connection** sends a small prompt and shows the reply and the response time, or the
  error.
- **API keys** are encrypted at rest with `SECRET_KEY` and are never shown again; only the
  last 4 characters are displayed.
- **Model priority**: chat tries the models in order; when one fails (busy, rate-limited, down)
  the next one answers. The timeout is set per model under advanced options.
- **Costs**: optionally enter USD per 1M input/output tokens. Otherwise a built-in list of
  common models' prices is used (unknown models cost 0). Usage and cost appear in Stats and on
  the Dashboard.

**Local model servers** (Bionic, Ollama, vLLM, LM Studio) stay in the list. Cloudflare can't
reach `localhost`, `host.docker.internal` or private-network addresses, so **Test connection**
and chat answer: *"Local model servers can't be reached from Cloudflare. Use a cloud provider,
or expose the server on a public HTTPS URL."* A model server published on a public HTTPS
address (for example through a Cloudflare Tunnel) works like any OpenAI-compatible server.

In on-premise mode, choosing a cloud provider shows a warning: *visitor questions and content
will be sent outside this server.*

## 8. API actions (optional)

API actions let the assistant use a client's **own API** for live data and changes, for
example checking free appointment slots and booking an appointment, in addition to answering
from crawled pages and documents.

**Off by default** for every client. While it is off (or no action is enabled), chat works
exactly as before.

### Turning it on

1. Open the client → **API actions** and switch on **Enable API actions for this client**
   (super admins only; client admins see the configuration read-only, without the key).
2. **Connection**:
   - **API URL**: the base URL, e.g. `https://api.hospital.example/v1`. Action paths are added to it.
   - **Authentication**: *Header* (e.g. `X-API-Key: <key>`), *Bearer* (`Authorization: Bearer <key>`)
     or *Query* (`?api_key=<key>`), plus the header or parameter name.
   - **API key**: stored encrypted with `SECRET_KEY` and shown only as `••••1234`. Saving with
     the field empty keeps the current key; **Replace key** sets a new one.
   - **Timeout** (default 15 s), optional **extra headers**, and an optional **health check
     path** used by **Test connection**.
3. **Actions**: each has a snake_case **name** (e.g. `get_slots`), a **description** that tells
   the assistant when to use it, a **method** and **path** (with `{placeholders}` for path
   parameters, e.g. `/doctors/{doctor_id}/slots`), **parameters** (name, type: string,
   integer, number, boolean, date, phone or email; location: path, query or body; required;
   description; optional allowed values), and an optional **response hint** (which fields
   matter, e.g. "returns booking_id"). **Test** runs one action with parameters you enter.
4. Try it in **Test chat**: the diagnostics panel lists every action call with parameters,
   status, time and a response excerpt.

**Import from API** reads the API's own description (OpenAPI 3 or Swagger 2, JSON or YAML)
and lists every endpoint in a searchable table. It looks at the usual addresses
(`/openapi.json`, `/swagger.json`, `/v3/api-docs` …) on the API URL and its host, or you enter
the spec's URL or upload the file. Tick the endpoints the assistant should use: each becomes an
action with its parameters, types, required fields and allowed values filled in, and
confirmation switched on for anything that isn't `GET`. Endpoints you don't tick can never be
called. The spec is fetched with the client's API key only from the API's own host, and passes
the same address checks as action calls.

**Templates → Appointment booking** adds `list_departments`, `list_doctors`, `get_slots`,
`book_appointment` and `cancel_appointment`. They match the demo API below; adjust paths and
parameters to the client's real API.

### How a booking works

1. The visitor asks; the assistant searches the content as usual and may call read-only
   actions (`GET`) such as `get_slots`, up to 4 rounds per message.
2. When it wants to run an action that changes data, the server does **not** run it. It stores
   the request for this conversation (10 minutes) and replies with a summary written by the
   server, e.g. *Please confirm: Book appointment (doctor id: 1, date: 2026-10-12, time: 09:30,
   patient name: Sobish, phone: 98xxxxxx10). Reply yes to confirm or no to cancel.* The widget
   shows **Confirm** and **Cancel** buttons.
3. Only a clear yes (or the Confirm button) runs it; the assistant then reports the booking ID
   or the API's error. "No"/Cancel drops it, and any other message replaces it.

### Security

- The key, the API URL and the action definitions never reach the browser or the widget; the
  public chat API returns only the reply and, when needed, the confirmation summary.
- **Confirmation is enforced by the server** for every action that changes data (non-GET
  actions always require it); the model cannot skip it.
- **Every parameter is validated** against its type before a call (ISO dates, phone numbers,
  emails, allowed values, required fields, at most 500 characters); unknown parameters are rejected.
- **SSRF protection:** in cloud mode the URL must be `https://`, must not contain a user name or
  password, and must not name a private, loopback or link-local address, `localhost`, or a
  `.local`/`.internal` host. This is checked when saving and again before every call; redirects
  are never followed. Workers can't resolve DNS, so a public name pointing at a private address
  isn't detected in advance, but Cloudflare itself refuses such connections. On-premise mode
  allows plain `http://` and internal host names; Cloudflare still can't reach private networks,
  so such calls fail with an error saying so (expose the API on a public HTTPS URL instead).
- **Personal data:** the model sees phone numbers and emails only as placeholders such as
  `[phone_1]`; the real values are put back only in the request to the client's API. The call
  log masks them, and saved questions contain only the placeholders.
- API responses are cut to about 4,000 characters and given to the model as untrusted data,
  not instructions.
- **Rate limits** (Settings → Rate limits): 20 action calls per conversation per hour and
  3 confirmed changes per conversation per day by default. Calls time out after the configured
  timeout; only `GET` requests are retried, once, on connection errors.
- Disabling the feature keeps the configuration but stops using it immediately.

### Demo with the mock booking API

```bash
node demo/mock_booking_api.mjs        # http://127.0.0.1:8100, key demo-key
```

Cloudflare can only call public HTTPS addresses, so publish it first, e.g. with
`cloudflared tunnel --url http://localhost:8100`, and use the `https://…trycloudflare.com`
address it prints as the **API URL** (authentication **Header** `X-API-Key`, key `demo-key`,
health check path `/health`). With `wrangler dev` on the same computer you can instead switch to
**On-premise** mode and use `http://127.0.0.1:8100`. Click **Test connection**, add the
**Appointment booking** template and ask in Test chat: *"I need a cardiologist on Monday"*, then
*"Book 9:30 for Sobish, phone 9876543210"* and press **Confirm**.

### Model requirements

Actions need a model with reliable tool calling: GPT-4o-mini or newer, Claude, Gemini, or
Qwen 7B or larger (e.g. on DeepInfra). Small models are not reliable. If a model rejects tools,
the assistant answers from the content as usual and logs a warning.

## 9. Embedding the widget

Copy the line from client → **Embed code**:

```html
<script src="https://chat.example.com/widget.js" data-client="lulu-kochi" defer></script>
```

- It renders in a Shadow DOM, so the host page's CSS can't break it and it can't restyle the
  page.
- It shows a floating bubble that opens a chat window, with a typing indicator. It is
  keyboard accessible (Enter sends, Escape closes) and full-screen on phones.
- Branding (colour, logo, greeting, position, language, "Powered by") is loaded from
  `/api/client/<id>/config`. That response contains branding only, no secrets.
- Visitors see only the answer, not where it came from (pages and documents stay private). The
  notice "Chats are recorded to improve service" is shown and editable in Settings → Privacy.
- The widget only works on the client's **allowed domains**. Requests from other origins, or
  with no origin at all, are rejected.

**Try it locally:** add `localhost:5500` to the client's allowed domains, then:

```bash
node demo/serve.mjs
# open http://localhost:5500/?client=lulu-kochi&api=https://chat.example.com   (or api=http://localhost:8787)
```

## 10. Users and roles

**Users** (super admin only):

| Role | Can do |
|---|---|
| `super_admin` | Everything: clients, AI models, settings, users, system health, backups |
| `client_admin` | Only assigned clients: crawl, documents, branding, test chat, embed code, stats, conversations. Cannot change AI models, allowed domains or system settings. |

Disabling a user or changing their password signs them out everywhere. There is always at
least one active super admin.

## 11. Cloud vs on-premise

The code is the same in both modes. You choose the mode in the setup wizard and can change it
later in **Settings → Clients mode**. Switching keeps all content, settings, users and statistics.
Switching to on-premise needs at most one client (delete the others first, nothing is deleted
automatically); that client becomes the assistant.

| | Cloud | On-premise (single client) |
|---|---|---|
| Clients | many | exactly one (the Clients list is skipped) |
| API actions | `https://` public APIs only | also `http://` and internal host names (which Cloudflare can't reach; see [section 8](#security)) |
| Admin UI | usually on its own host name (`ADMIN_HOSTNAME`) | same |

A truly on-premise installation (local models, no internet) needs the
[self-hosted version](https://github.com/sobishj/Chatbot).

## 12. HTTPS and custom domains

Cloudflare serves the Worker over HTTPS with its own certificates, on `*.workers.dev` and on any
custom domain you add (Workers & Pages → *website-assistant* → Settings → Domains & Routes →
Add → Custom domain). Websites served over HTTPS can load the widget from either.

**Separate admin host name** (like the separate admin port of the self-hosted version): add two
custom domains, e.g. `chat.example.com` (public) and `admin.example.com` (admin), and set the
`ADMIN_HOSTNAME` variable in `wrangler.jsonc` to `"admin.example.com"`, then deploy. The admin
API then answers only on `admin.example.com`, and the public chat API only on the other host
names. Set **Settings → Public domain** to `chat.example.com`. To restrict the admin host name
further, put it behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/).

Session cookies are marked `Secure` automatically over HTTPS.

## 13. Backups and restore

**System health → Download backup** downloads a JSON export of every table: settings, users,
clients, pages, passages, questions and jobs.

- Saved API keys in the export stay encrypted and only work with the **same `SECRET_KEY`**.
- Uploaded files and logos live in Workers KV and are not in the export; Vectorize vectors
  are rebuilt by **Re-index**.
- D1 also keeps 7 days of point-in-time history on the free plan (Time Travel):
  `npx wrangler d1 time-travel restore website-assistant --timestamp=<ISO time>`.
- To restore an export into a new database, apply the migrations and insert the rows (each
  table is a list of rows with its column names).

## 14. Command line (developers and recovery)

Everything is available in the UI. For recovery, from `worker/`:

```bash
node scripts/reset-admin-password.mjs you@example.com "new password"   # also signs the user out everywhere
npx wrangler d1 execute website-assistant --remote --command "SELECT client_id, name FROM clients"
npx wrangler tail                                                     # live logs of the deployed Worker
npx wrangler vectorize info chunks                                    # vectors stored
```

## 15. Development and tests

```
worker/
  src/
    actions/    API actions: tool schema, executor (validation, SSRF guard), confirmations, chat flow, OpenAPI import
    analytics/  stats, conversations, CSV export, retention
    chat/       PII masking, language detection, prompt, essential pages, chat service, streaming
    crawler/    robots.txt, sitemaps, crawl job, HTML tokenizer and extraction rules
    documents/  uploads (Workers KV), toMarkdown parsing, sync job
    embeddings/ Workers AI and cloud embedding APIs, model catalog
    indexer/    chunking (~500 tokens, 50 overlap), resumable indexing, Vectorize clean-up
    llm/        OpenAI-compatible, Anthropic and Gemini adapters, provider presets, prices
    routes/     public API, /health, admin API routers
    storage/    Workers KV file store (uploads, logos, large extracted texts)
    search/     hybrid search (Vectorize + FTS5, RRF)
    security/   PBKDF2 passwords, AES-GCM secrets, signed sessions, CSRF
    services/   settings, clients, users, AI models, jobs, rate limits, embeddings
    worker/     job runner, handlers, scheduler (cron)
  migrations/   D1 schema
  test/         vitest tests (run inside the Workers runtime)
  scripts/      asset build, mock model server, password reset
  wrangler.jsonc
app/widget/     widget.js (vanilla JS, Shadow DOM), served unchanged as a static asset
frontend/       React + TypeScript admin UI
demo/           demo page and mock booking API
```

```bash
cd worker
npm install
cp .dev.vars.example .dev.vars          # set SECRET_KEY
npx wrangler d1 migrations apply website-assistant --local
npm run build                           # the admin UI must exist before `wrangler dev`
npm run dev                             # http://localhost:8787  (D1/KV local, Vectorize/Workers AI remote)
npm test                                # vitest
npx tsc --noEmit                        # type check

cd ../frontend && npm install && npm run dev   # UI dev server on :5173, proxies /api to :8787
```

`wrangler dev` uses your Cloudflare account's real Vectorize index and Workers AI (they have no
local simulator); D1 and Workers KV are local. `node scripts/mock-llm.mjs` starts an OpenAI-compatible
mock model on `http://127.0.0.1:8799/v1`; with `DEV_ALLOW_PRIVATE_URLS="1"` in `.dev.vars` you can
add it as an "Other OpenAI-compatible server" for tests without API keys.

Tests use in-memory fakes for Vectorize and Workers AI, scripted LLMs (plain and tool-calling)
and a mocked network, so they need no Cloudflare account or API keys.

## 16. Configuration reference

Everything a user can change lives in D1 and is edited in the UI. The Worker itself has:

| Setting | Where | Purpose |
|---|---|---|
| `SECRET_KEY` | `wrangler secret put SECRET_KEY` (`.dev.vars` in development) | Encrypts API keys, signs sessions. **Never change after setup.** |
| `ADMIN_HOSTNAME` | `vars` in `wrangler.jsonc` | Optional: serve the admin API only on this host name |
| `DEV_ALLOW_PRIVATE_URLS` | `.dev.vars` only | Development only: allow model/API URLs on this computer |
| `DB` | `d1_databases` | The D1 database |
| `VECTORIZE` | `vectorize` | The `chunks` index (1024 dims, cosine) |
| `AI` | `ai` | Workers AI (embeddings, document conversion) |
| `FILES_KV` | `kv_namespaces` | Workers KV namespace for uploaded documents, logos and large extracted texts |
| `triggers.crons` | `wrangler.jsonc` | The per-minute scheduler (`* * * * *`) |

## 17. Troubleshooting

| Symptom | Fix |
|---|---|
| Widget doesn't appear | Browser console shows `[Website Assistant] not loaded: config 403`: add the site's domain under **Allowed domains**. |
| "Local model servers can't be reached from Cloudflare" | Use a cloud provider, or publish the model server on a public HTTPS address (e.g. a Cloudflare Tunnel). |
| Crawl finds few pages | Check robots.txt, the include/exclude patterns and the page limit. Sites that render their content with JavaScript only aren't supported (their page description is still used). |
| Crawl or indexing is slow | Keep the job's progress open in the admin UI: every progress check advances it. Without it, the scheduler advances jobs once a minute. |
| New pages aren't found by meaning right after indexing | Vectorize makes new vectors searchable within about a minute; keyword search works at once. |
| Answers marked unanswered although correct | Lower **Settings → Answers → confidence threshold**. Test chat shows each answer's score. |
| Worker/Scheduler "Problem" on System health | The cron trigger isn't running: check Workers & Pages → *website-assistant* → Settings → Trigger events, and `npx wrangler tail`. |
| Error 1102 (CPU limit) in the logs | A page or document step needed more CPU than the free plan allows; the job retries it. Very large pages can need Workers Paid. |
| Forgot admin password | `node scripts/reset-admin-password.mjs you@example.com "new password"` |
| API key shows "Unreadable" | `SECRET_KEY` changed. Restore the old key or re-enter the API keys. |

## Free plan limits

Checked against Cloudflare's documentation in November 2026; Cloudflare changes these from time
to time.

| Limit (free plan) | Value | What it means here |
|---|---|---|
| Worker requests | 100,000 per day | Chat messages, widget loads (`widget.js` and config) and admin use together |
| CPU time | 10 ms per request and per cron run | Crawling and indexing run as small resumable steps; chat is mostly waiting on the model |
| Subrequests | 50 per invocation (fetch, D1, KV) | Each job step stays well below it |
| D1 | 5 GB per account, 500 MB per database | Pages, passages and questions; plenty for most sites |
| D1 queries | 50 per invocation | Batched where possible |
| Vectorize | 5 million stored dimensions, 30 million queried per month | At 1024 dimensions ≈ **4,880 passages in total**, across all clients |
| Workers AI | 10,000 neurons per day | bge-m3 uses ~1,075 neurons per million tokens: roughly 9 million tokens of indexing/questions per day |
| Workers KV storage | 1 GB, at most 25 MB per file | Uploads, logos and large document text; files over 25 MB are refused |
| Workers KV writes | 1,000 per day (deletes: 1,000; lists: 1,000) | About 1,000 uploads or logo changes a day; a document whose text is over ~900 KB uses a second write |
| Workers KV reads | 100,000 per day | Indexing reads each new or changed file once; the widget reads the logo |
| Request body | 100 MB | All files of one upload together |
| Cron triggers | 5 per account | This Worker uses one |

The **Vectorize allowance is the limit most installations meet first**: about 4,880 passages is
a few hundred web pages plus some documents. The System page shows the use. Beyond it,
Cloudflare's paid plans raise every limit above.

## Features that need the self-hosted version

These are in the admin UI (nothing is hidden) but can't work on Cloudflare. Choosing them shows a
clear message. They work in the self-hosted version: [github.com/sobishj/Chatbot](https://github.com/sobishj/Chatbot).

| Feature | On Cloudflare |
|---|---|
| **Local LLMs** (Bionic, Ollama, vLLM, LM Studio on `localhost` or the local network) | Fail fast with *"Local model servers can't be reached from Cloudflare…"*. A model server on a public HTTPS address works. |
| **Local embedding models** (Hugging Face `BAAI/bge-m3`, `multilingual-e5-small`, `bge-small-en`) | Choosing one returns a message; the current model stays. Use Workers AI bge-m3 (the same model) or a cloud model. |
| **Compute device (CPU/GPU)** | Saved but has no effect; the System page reports no GPU. |
| **Watched folders** | Saving a folder or **Scan now** returns a message. Upload the files instead. |
| **Tesseract OCR** for scanned PDFs | Scanned PDFs are marked *"No text found: this looks like a scanned PDF."* |
| **Private-network API actions** | Cloudflare can't reach private addresses; publish the API on a public HTTPS URL. |
| **Fully offline operation** | Needs a server of your own. |
