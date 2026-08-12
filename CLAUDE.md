# CLAUDE.md — AIPost MCP Server

## Version management

- The canonical version is **only** in `package.json:3` (`"version": "1.1.6"`). No other file hardcodes it.
- **`smithery.yaml` MUST be updated every release.** The `npx` arg pins the version explicitly (`@aipost/mcp-server@1.1.6`). Without a version tag, Smithery's npx cache can serve a stale old version indefinitely — this is why Smithery was stuck on 1.1.1 while npm had 1.1.6.
- After pushing `smithery.yaml` changes, **rebuild the Smithery deployment** on smithery.ai. Smithery reads `smithery.yaml` at deploy time, not at runtime.

## Smithery configSchema

- `smithery.yaml` defines a `configSchema` that prompts each user for values on the Smithery deployment page.
- Adding a new env var that users should configure → add a field to `configSchema.properties` AND wire it into `commandFunction`'s `env` object.
- Changing `commandFunction` does NOT take effect until the deployment is rebuilt on Smithery.
- Example: `AIPOST_SENDER_WHITELIST` is exposed as `aipostSenderWhitelist` in the schema.

## Windows caveat

- On Windows, `npx -y @aipost/mcp-server` fails because the `mcp-server` bin entry is not found (shebang issue).
  - **Workaround:** use the `aipost-mcp` bin instead: `npx -y -p @aipost/mcp-server aipost-mcp`
- This affects local development on Windows; Smithery runs Linux so it's not affected there.

## Sender filter (blacklist / whitelist)

- Controlled by two env vars: `AIPOST_SENDER_WHITELIST` and `AIPOST_SENDER_BLACKLIST`.
- **Whitelist takes precedence:** if both are set, blacklist is ignored.
- The filter applies to ALL 12 tools — inbox, outbox, threads, events, directory, send_message, reply_to, get_message, delete_message.
- Implementation: `src/filter.ts` → `SenderFilter` class, used in `src/server.ts` `createAipostServer()`.
- For local stdio MCP clients, set env vars in the MCP client config's `env` block.
- For Smithery HTTP deployments, env vars must be configured through the `configSchema` flow (see above).

### Address formats supported

| Format | Example |
|--------|---------|
| Short dot | `alias.aipost.email` |
| Full dot | `keyname.alias.aipost.email` |
| Short @ | `alias@aipost.email` |
| Full @ | `keyname.alias@aipost.email` |
| Standard email | `user@domain.tld` |
| Domain-only | `@domain.tld` |

### Matching rules

- `spammer` or `spammer@aipost.email` → matches any sender with alias `spammer`, regardless of keyname.
- `evil.spammer` → matches only sender with keyname `evil` AND alias `spammer`.
- `@baddomain.com` → matches any `user@baddomain.com`.
- For external emails (IMAP imports), both `sender` and `payload.from` are checked.

## Architecture

```
src/
  index.ts       → Main entry (creates AipostClient, SenderFilter, EventStream, Server)
  http.ts        → HTTP transport entry (for StreamableHTTPServerTransport)
  server.ts      → createAipostServer() — registers all 12 MCP tools
  filter.ts      → SenderFilter class — blacklist/whitelist logic
  api.ts         → AipostClient (API calls) + EventStream (SSE)
  crypto.ts      → ED25519 signing
```

## Publishing

See memory: [[Publish Workflow]].

Key steps: bump `package.json` version → update `smithery.yaml` version → `git commit` → `git push` → `npm publish --access public` → rebuild Smithery deployment.

## npx caching gotcha

- `npx -y @aipost/mcp-server` (no version) relies on npm's `latest` tag, but npx maintains its own cache.
- On Smithery's infrastructure, the npx cache persists across restarts but not across rebuilds.
- **Always pin the version** in `smithery.yaml` to avoid stale caches.
