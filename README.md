# DON'T FORGET ME

A memory-driven mystery set in a small Vietnamese neighborhood shop. Serve customers, listen to their stories, and work out which details still hold up when someone changes their account of the past.

[Play in your browser](https://dont-forget-me-iota.vercel.app/)

[Watch the gameplay demo on YouTube](https://youtu.be/vVY7D2egUNE)

The story spans six days with two possible endings. The shop is also the place where you investigate: a purchase, a receipt, or an offhand remark can matter later. NPC conversations use an LLM and the memories available to that character in your current case.

## Playing

Use a desktop browser with sound enabled. Open **Account**, sign in through the browser, then return to the game and resume the browser session if prompted. Start or resume your case.

- Follow customer orders and the on-screen control hints to pick up products, check prices, take payment, and return change.
- Use the view controls to move between the counter, shelves, and refrigerator.
- Click the dialogue box to continue. Choose a reply or use **Ask** when conversation is available.
- Open **Journal** and **Remembered** to inspect earlier records and their sources.
- Use **Call a witness** when available to revisit testimony. The epilogue becomes available after the relevant case outcome.

Listen carefully: a remembered claim is something a character said, not automatic proof that it happened. If a generated reply is unavailable, retry it. The game holds the conversation rather than inventing a successful result.

## How memory changes the game

Walrus Memory stores conversation records, player decisions, and evidence associated with each player's case. Retrieval supplies the NPC with relevant earlier exchanges, so returning to a subject can produce a different response from asking about it for the first time.

Each record carries its source and scope. The backend separates testimony from verified game events, checks references in generated replies, and controls which facts a character is allowed to know. The LLM cannot award clues, settle a purchase, or choose an ending on its own.

PostgreSQL holds active sessions, game authority, and the durable write queue. Walrus Mainnet provides persistent memory records and recovery material. The service also includes checkpoint recovery, public case sharing, and account ownership workflows. Wallet operations require the owner's signature; storing memories through the hosted game's sponsored account does not require each player to connect a wallet.

## Repository

| Directory | Contents |
| --- | --- |
| `game/` | Godot project, scenes, scripts, story data, and assets |
| `server/src/` | Authentication, dialogue, evidence, memory, and game authority |
| `server/migrations/` | PostgreSQL schema migrations |
| `server/tests/` | Backend tests and synthetic fixtures |
| `server/scripts/` | Local setup, maintenance, and verification utilities |
| `web/` | Browser loading page, account pages, case pages, and hosting configuration |

## Requirements

- Godot 4.7 with matching export templates for building the game
- Node.js 22 and npm
- PostgreSQL for the connected runtime; Docker can provision a local instance
- An OpenAI-compatible chat-completions endpoint for generated dialogue
- A Walrus Memory account and delegate credentials for Mainnet storage
- An OIDC identity provider for production sign-in

## Local setup

```sh
git clone https://github.com/maixuancanh/dont-forget-me.git
cd dont-forget-me/server
npm ci
```

Copy `.env.example` to `.env`. Generate a session secret and place it in `SESSION_SECRET`:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Start the development service:

```sh
npm run dev
```

The default API address is `http://127.0.0.1:8798`. Import `game/project.godot` in Godot and run the project. Native builds use that local address by default; set `DFM_SERVICE_URL` before launching to use another backend.

Development mode supports local access-code accounts. It is useful for setup and testing, but it does not count as Mainnet memory or verified player participation. Without LLM credentials, generated conversations are unavailable.

For the PostgreSQL runtime, start Docker and run this from `server/` after creating `.env`:

```sh
node scripts/setup-local-database.mjs
npm run dev
```

The setup utility provisions a dedicated database on port 55450 and writes its connection string into your private `.env`. It leaves an existing `DATABASE_URL` unchanged.

## LLM connection

Set these backend variables:

```dotenv
LLM_BASE_URL=https://your-provider.example/v1
LLM_API_KEY=your-private-api-key
LLM_MODEL=your-provider-model-id
```

The provider must accept chat-completions requests and support structured JSON replies. Model identifiers depend on your provider. For GPT models, use credentials and an endpoint that explicitly support API access; a browser sign-in alone is not a server credential.

Keep these values on the server. The Godot client sends game requests to the backend, which builds the authorized context, retrieves memory, calls the model, and validates the reply before returning it.

## Walrus Memory

Create an account and delegate through the [Walrus Memory dashboard](https://memory.walrus.xyz/dashboard). Configure:

```dotenv
MEMORY_MODE=mainnet
MEMWAL_ACCOUNT_ID=your-MemWalAccount-object-id
MEMWAL_PRIVATE_KEY=your-private-delegate-key
MEMWAL_SERVER_URL=https://relayer.memory.walrus.xyz
```

The account ID is the Sui account object ID, not the delegate public key or owner wallet address. Keep the delegate private key out of the browser and Git.

To make a deliberate paid test write and attempt recall:

```sh
npm run verify:mainnet
```

This creates a verification record, not a player interaction. Some independent Seal read paths require committee-specific credentials through `SEAL_SERVER_CONFIGS`; managed SDK access and direct Seal access are separate capabilities.

## Production authentication and hosting

Production requires HTTPS, PostgreSQL, Mainnet memory, an LLM provider, and complete OIDC configuration. Set `APP_MODE=production`, an HTTPS `ALLOWED_ORIGIN`, and the authentication fields in `.env.example`. Register the callback URL from `OIDC_REDIRECT_URI` with your identity provider. Development access-code login is disabled in production.

Build the API container from the repository root:

```sh
docker build -t dont-forget-me-api .
docker run --env-file server/.env -p 8798:8798 dont-forget-me-api
```

The container listens on port 8798 by default. Use your host's private environment settings for deployed credentials. The public `/health` endpoint can be used for availability checks.

For a web build, install the matching Godot export templates, create `build/web/`, and run:

```sh
godot --headless --path game --editor --import
godot --headless --path game --export-release Web ../build/web/index.html
```

Copy the generated loader, worklets, `.wasm`, `.pck`, and icons into `web/`. Preserve the branded `web/index.html`; refresh its generated engine configuration from the exported HTML when changing Godot versions or export settings. Compiled game files are intentionally not tracked.

Deploy `web/` as a static site. `web/vercel.json` contains the hosted game's API rewrites; replace their destinations with your own API host when deploying a fork. Web clients use same-origin `/v1` and `/v2` routes. Keep account and API routes on the same public origin for browser sessions.

## Checks

From `server/`:

```sh
npm run build
npm test
```

`build` checks TypeScript without emitting JavaScript. Database integration tests require an isolated test database; use `compose.test.yml` and `DFM_TEST_DATABASE_URL`. Never point tests at a live player database. Mainnet verification is a separate operation and is not part of ordinary unit testing.

## Current limitations

Generated replies depend on provider availability and validation. A failed reply can pause an interaction until retried. The account lifecycle and recovery features need the appropriate credentials and permissions; the presence of an interface does not guarantee that every wallet operation has been completed on Mainnet. The game remains a prototype, and a full playthrough is recommended before demonstrating a particular ending.

## Credits

The shop interaction foundation is adapted from [Narinig Mo Ba?](https://narinigmoba.lol/). This project adds a Vietnamese setting, revised story and artwork, persistent NPC memory, and a separate backend. Third-party code, artwork, audio, fonts, and dependencies retain their respective rights. This repository does not grant a blanket license for third-party material.
