# Browser Worker (Auth0 login + screenshot)

This Cloudflare Worker uses the Cloudflare Browser (via `@cloudflare/puppeteer`) to log in to a site (Auth0 Lock example) and take screenshots. It supports storing session cookies in a KV namespace so you don't have to log in on every request.

## Features
- Programmatic form-based login (supports Auth0 Lock).
- Cookie persistence to a KV namespace (`BROWSER_KV_DEMO`) for session reuse.
- Read credentials from environment secrets (`LOGIN_USER`, `LOGIN_PASS`).
- Flexible selectors configurable via environment variables for different login UIs.
- Screenshot of a target page after login.

## Files of interest
- `src/index.js` — Worker entry. Contains `ensureLoggedIn` helper and screenshot flow.
- `wrangler.jsonc` — Wrangler configuration (includes `compatibility_flags: ["nodejs_compat"]`).

## Requirements
- Node.js (compatible with Wrangler tooling)
- Wrangler (installed via npm)
- `pnpm`/`npm` to install dependencies (project already has dependencies configured)
- A Chromium-based browser available to the Cloudflare Browser runtime when using the inspector locally (optional)

## Local setup (Windows PowerShell)
1. Install dependencies (if not already):
```powershell
cd C:\Users\theo\browser-worker
npm install
```

2. Add environment variables for local development. For non-secret values you can add them to a local `.env` file (Wrangler reads `.env` when running `wrangler dev`):

Example `.env` entries (do NOT store secrets in version control):
```
TARGET_URL=https://example.com/protected-page
LOGIN_URL=https://example.com/login
LOGIN_USER_SELECTOR=input[name="email"]
LOGIN_PASS_SELECTOR=input[name="password"]
LOGIN_SUBMIT_SELECTOR=.auth0-lock-submit
LOGIN_SUCCESS_SELECTOR=.profile-avatar
```

Auth0-specific selectors
------------------------
If your site uses Auth0 Lock (client-rendered UI), set these selectors so the worker can interact with the Lock widget and detect a successful login. These are the recommended values that work in most Auth0 Lock setups:

```
LOGIN_USER_SELECTOR=input[name="email"]
LOGIN_PASS_SELECTOR=input[name="password"]
LOGIN_SUBMIT_SELECTOR=.auth0-lock-submit
# If the submit button uses an ID that begins with a digit (e.g. id="1-submit"), use the escaped CSS id literal in your .env:
LOGIN_SUBMIT_SELECTOR=#\31 -submit
# An element that only appears after the app has finished the auth callback and client routing
LOGIN_SUCCESS_SELECTOR=.profile-avatar    # change to a selector that exists only after login in your app
```

Notes for Blazor Server apps
---------------------------
- Blazor Server often finishes client-side routing after the auth callback completes. If you find the worker stopping at the Auth0 intermediate URL, set `LOGIN_SUCCESS_SELECTOR` to an element that appears only after your Blazor app renders post-login (for instance a logout button, user avatar, or main app container id like `#app` or `.main-layout`).
- If your callback URL is stable (for example `https://yourdomain.com/callback`), you can also rely on the worker waiting for that redirect by setting `TARGET_URL` or passing `?url=` to the worker.
- The worker now scans frames and auto-submits `form[method="post"]` pages (Auth0 `response_mode=form_post`) so the callback POST is followed automatically, but you still need a reliable `LOGIN_SUCCESS_SELECTOR` or expected `url` to screenshot the final app state.

3. Store credentials securely with Wrangler secrets (recommended):
```powershell
cd C:\Users\theo\browser-worker
npx wrangler secret put LOGIN_USER
npx wrangler secret put LOGIN_PASS
```
You will be prompted to paste the secret value.

4. (Optional) If you prefer to store non-sensitive values as Wrangler `vars` instead of `.env`, add them in `wrangler.jsonc` or use `wrangler` commands.

## How it works / Usage
- Run the worker in dev mode:
```powershell
cd C:\Users\theo\browser-worker
npx wrangler dev
```
- The worker supports both query parameters and environment fallbacks:
  - `?login=` — login page URL (falls back to `LOGIN_URL` / `env.LOGIN_URL`)
  - `?url=` — target page to screenshot (falls back to `TARGET_URL` / `env.TARGET_URL`)

Examples
- Screenshot a protected page (login first):
```
http://127.0.0.1:8787/?login=https://example.com/login&url=https://example.com/protected
```
- Just log in and screenshot the page shown after login (no explicit target):
```
http://127.0.0.1:8787/?login=https://example.com/login
```

Behavior
- On first successful login the worker saves cookies into the KV namespace `BROWSER_KV_DEMO` keyed by `cookies:<loginUrl>`.
- Subsequent requests will attempt to restore cookies first and skip the login if the session appears valid.
- The worker detects login success by either navigation after submitting credentials or by waiting for a selector you provide via `LOGIN_SUCCESS_SELECTOR`.

## Environment variables (summary)
- LOGIN_USER (secret) — username/email (use `wrangler secret put`)
- LOGIN_PASS (secret) — password (use `wrangler secret put`)
- LOGIN_URL — login page URL (optional)
- TARGET_URL — fallback target page URL (optional)
- LOGIN_USER_SELECTOR — CSS selector for the username/email input (e.g. `input[name="email"]`)
- LOGIN_PASS_SELECTOR — CSS selector for the password input (e.g. `input[name="password"]`)
- LOGIN_SUBMIT_SELECTOR — CSS selector for the submit element (e.g. `.auth0-lock-submit` or `#\\31 -submit`)
- LOGIN_SUCCESS_SELECTOR — Optional selector that is present only when logged in (used to detect success)

Notes on selectors
- For IDs that start with a digit (like `id="1-submit"`), use the escaped CSS form: `#\\31 -submit` in your `.env` file.
- The worker's defaults are tailored for Auth0 Lock (e.g., `input[name="email"]`, `.auth0-lock-submit`) but you should set the selectors to match your page.

## Cookie management
- Cookies are saved to `BROWSER_KV_DEMO` with key `cookies:<loginUrl>` and a 7-day TTL by default.
- If you need to clear saved cookies, you can delete that key from KV (or we can add an endpoint to clear cookies programmatically).

## Troubleshooting
- Timeout waiting for inputs: increase selector timeouts or ensure selectors are correct and the Lock UI has rendered.
- Page uses XHR login (no navigation): set `LOGIN_SUCCESS_SELECTOR` to an element that appears after login and the worker will wait for it.
- Auth0 / OAuth redirects: The worker waits for navigation after submit; if your flow uses an external callback, ensure the callback completes within the configured timeouts.
- If you see an error about `node:buffer` when running dev, ensure `wrangler.jsonc` contains:
```json
"compatibility_flags": ["nodejs_compat"]
```

## Security
- Never commit credentials to Git. Use `wrangler secret put` for sensitive values.
- For production, ensure you understand the target site's terms of service before automating logins and screenshots.

## Next steps / optional improvements
- Add an endpoint to clear cookies: `?action=clear-cookies&login=<url>`.
- Make screenshot size/format configurable via query params.
- Add retries and more robust error logging for flaky networks or delayed Lock rendering.

If you want, I can patch the worker to add a cookie-clear endpoint and/or make the screenshot options configurable. Tell me which option to implement next.
