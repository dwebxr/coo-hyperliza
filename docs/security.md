# Security

What an operator has to know about the session token, the elizaOS web UI / API, error reports and stored secrets. The risks that were accepted are listed in [Known Limits](known-limits.md).

## The Session Token File

`localstorage.json` holds the agent's Hyperfy auth token. Never commit it, and never paste logs that contain it.

## The elizaOS Web UI / API

Whoever may use the elizaOS web UI / API can read the `.env` file the server finds (`GET /api/system/env/local`: every key, `TIP_WALLET_PRIVATE_KEY` included) and rewrite it (`POST`), read the agent's stored database record including its stored secrets (`GET /api/agents/<id>`), control the agent, and over its Socket.IO connections send the agent messages and stream its logs. elizaOS authenticates the REST API only when `ELIZA_SERVER_AUTH_TOKEN` is set (clients send it as `X-API-KEY`) and Socket.IO only when `SERVER_API_KEY` is set (the web UI sends the one key it stores for both), and listens on every interface (`0.0.0.0`) when `SERVER_HOST` is unset. So when the CLI loads this project (`elizaos start` / `elizaos dev`, which `bun run start` / `bun run dev` run), Coo, at startup:
- with `SERVER_HOST` unset, makes the server listen on `127.0.0.1` only;
- with `ELIZA_SERVER_AUTH_TOKEN` unset or empty, locks the REST API and Socket.IO for that run with a random token that is never shown or stored: every request under `/api` gets 401 (except CORS preflight `OPTIONS` requests, which elizaOS answers without the token and which carry nothing) and every Socket.IO connection is refused, unless you set `SERVER_API_KEY` yourself: Socket.IO then accepts that key while the REST API stays locked (the `/healthz` and `/health` status routes and the web UI's own files still answer). A request's body is read and parsed before the token is checked (elizaOS registers its JSON body parser before its authentication; up to `EXPRESS_MAX_PAYLOAD`, 2 MB by default): a malformed JSON body is answered 500 and logged as an API error (and reported, if you set a Sentry DSN), whatever token it carries. To use the web UI or API, set your own `ELIZA_SERVER_AUTH_TOKEN` in `.env` and restart;
- with `SERVER_API_KEY` unset, uses the REST token for Socket.IO too, so your own token unlocks both.

### Start Paths That Skip Coo's Defaults

**These defaults only apply when the CLI loads this project.** `elizaos start --character <file>` and `elizaos dev --character <file>` start the server without loading it, and then none of the above applies. The same holds when the project fails to load (a failed build, a missing dependency): the CLI only logs a warning (`Failed to import project`) and still starts the server, without Coo and without these defaults. On those start paths only `.env` protects the server (the CLI loads `.env` over the environment: a key that is in `.env`, even with an empty value, replaces the same variable from the shell), and it needs all three of these:
- `SERVER_HOST=127.0.0.1`;
- `ELIZA_SERVER_AUTH_TOKEN=<your token>` (the REST API);
- `SERVER_API_KEY=<the same token>` (Socket.IO reads this one, not the REST token).

Without them, such a start serves the REST API and Socket.IO with no authentication on every network interface: anyone who can reach the port can read and rewrite `.env`, read the stored secrets and control the agent. The example file has all three; fill in your own token for both, and keep the three lines in `.env` in any case.

### What Remains

With your own token, the API is as strong as that token, and anyone who has it can read and rewrite `.env`; with a token and a non-loopback `SERVER_HOST`, anyone on the network who has the token can (Coo logs a warning then). On the locked default, other programs on this machine and web pages in your browser cannot use the REST API or Socket.IO. The token does not cover `/media/uploads/...` and `/media/generated/...`, which serve files from elizaOS's data directory to whoever knows the agent or channel id and the file name (Coo itself puts none there). The random token lives in the agent's process environment; the processes the agent starts (Chromium, ffmpeg) are given a reduced environment without it and without the API keys.

## Error Reports

The elizaOS server sends error reports (which can hold chat text, file paths and settings) to elizaOS's own Sentry project unless `SENTRY_DSN` names another, and an empty `SENTRY_DSN` means that default. When the CLI loads this project, Coo sets `SENTRY_DSN=off` for the run while it is unset or empty, and logs one `[Security]` line: Sentry then logs `Invalid Sentry Dsn: off` once, creates no transport and sends nothing. Your own DSN is left alone. `elizaos start --character <file>` does not load the project, so there only `.env` holds: keep `SENTRY_DSN=off` there (the example file has it), or put your own DSN.

## Stored Secrets

Coo does not copy `.env` into the agent record. On each start it deletes what earlier versions stored there: the keys that are in `.env` now, in the start's own merge, and, once the agent has started, every other stored secret except the settings elizaOS reads from the record and the variables its CLI copies. That includes secrets added through the web UI, which therefore do not survive a restart. A setting elizaOS reads from the record (such as `OBJECT_SMALL_TEMPERATURE`) stays stored, and in force, after you remove it from `.env`; delete it from the agent record to drop it. If that second step fails, the log says so (`[Secrets] Could not …`) and those keys stay stored. elizaOS itself still stores the variables its CLI copies from the environment, notably `POSTGRES_URL` (or `PGLITE_DATA_DIR`), and the settings it reads from the record (such as per-model tuning like `OBJECT_SMALL_TEMPERATURE`). Stored secrets are encrypted with `SECRET_SALT`; its default, `secretsalt`, is public, so set your own.
