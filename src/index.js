/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import puppeteer from "@cloudflare/puppeteer";

function maskSecrets(key, value) {
  if (!key) return value;
  const secretKeys = ['LOGIN_PASS', 'LOGIN_USER', 'password', 'passwd'];
  if (secretKeys.includes(key.toString().toUpperCase())) return '****';
  return value;
}

function log(env, level, message, meta) {
  // If env.DEBUG is set to 'false' explicitly, don't log. Otherwise log by default.
  try {
    const debug = env && (env.DEBUG === 'false' || env.DEBUG === '0') ? false : true;
    if (!debug) return;
  } catch (e) {
    // fall through to allow logging
  }
  const now = new Date().toISOString();
  const metaStr = meta
    ? Object.entries(meta).reduce((acc, [k, v]) => {
        try {
          acc[k] = maskSecrets(k, v);
        } catch (e) {
          acc[k] = String(v);
        }
        return acc;
      }, {})
    : undefined;
  if (metaStr) {
    console.log(`[${now}] [${level}] ${message} ${JSON.stringify(metaStr)}`);
  } else {
    console.log(`[${now}] [${level}] ${message}`);
  }
}

async function ensureLoggedIn(page, env, loginUrl, cookieKey, expectedRedirectUrl = null) {
  log(env, 'debug', 'ensureLoggedIn: attempting to restore cookies', { cookieKey });
  // Try to restore cookies from KV
  try {
    const saved = await env.BROWSER_KV_DEMO.get(cookieKey);
    if (saved) {
      log(env, 'debug', 'ensureLoggedIn: found saved cookies', { cookieKey });
      const cookies = JSON.parse(saved);
      if (cookies && cookies.length) {
        await page.setCookie(...cookies);
        log(env, 'debug', 'ensureLoggedIn: set cookies on page', { count: cookies.length });
        // navigate to confirm session is valid
        await page.goto(loginUrl, { waitUntil: 'networkidle0' });
        log(env, 'debug', 'ensureLoggedIn: navigated to loginUrl to validate session', { loginUrl });
        // simple check for a logged-in indicator — replace with a selector appropriate for your site
        if (env.LOGIN_SUCCESS_SELECTOR) {
          if (await page.$(env.LOGIN_SUCCESS_SELECTOR)) {
            log(env, 'info', 'ensureLoggedIn: session appears valid via LOGIN_SUCCESS_SELECTOR', { selector: env.LOGIN_SUCCESS_SELECTOR });
            return;
          }
        } else if (await page.$('.profile-avatar')) {
          log(env, 'info', 'ensureLoggedIn: session appears valid via .profile-avatar');
          return;
        }
      }
    }
  } catch (e) {
    // restore failed — fall through to fresh login
    log(env, 'warn', 'ensureLoggedIn: cookie restore failed, will attempt fresh login', { error: e && e.message });
  }

  // Perform form-based login using selectors (customize via env bindings if needed)
  // Provide helpful defaults: check common input names used by Auth0 Lock
  const userSelector = env.LOGIN_USER_SELECTOR || 'input[name="email"], input[name="username"], #username';
  const passSelector = env.LOGIN_PASS_SELECTOR || 'input[name="password"], #password';
  // default submit selector: prefer Auth0 Lock class, then normal submit, then escaped id
  const submitSelector = env.LOGIN_SUBMIT_SELECTOR || '.auth0-lock-submit, button[type="submit"], #\\31 -submit';
  const successSelector = env.LOGIN_SUCCESS_SELECTOR || null;

  log(env, 'info', 'ensureLoggedIn: navigating to login page', { loginUrl });
  await page.goto(loginUrl, { waitUntil: 'networkidle0' });

  // Wait for Lock container (if present) to render, but don't fail if it doesn't appear
  try {
    await page.waitForSelector('.auth0-lock-container', { timeout: 5000 });
  } catch (e) {
    // ignore - will still try to find inputs
  }

  // Wait for username input to appear (longer timeout)
  try {
    await page.waitForSelector(userSelector, { timeout: 15000 });
  } catch (e) {
    console.warn('username selector not found within timeout:', userSelector);
  }

  // Type credentials only if fields are present
  try {
    const userEl = await page.$(userSelector);
    if (userEl) {
      log(env, 'debug', 'ensureLoggedIn: typing username', { userSelector });
      await page.type(userSelector, env.LOGIN_USER);
    } else {
      log(env, 'warn', 'ensureLoggedIn: username selector not found', { userSelector });
    }
  } catch (e) {
    log(env, 'error', 'ensureLoggedIn: failed to type username', { error: e && e.message });
  }

  try {
    const passEl = await page.$(passSelector);
    if (passEl) {
      log(env, 'debug', 'ensureLoggedIn: typing password', { passSelector });
      await page.type(passSelector, env.LOGIN_PASS);
    } else {
      log(env, 'warn', 'ensureLoggedIn: password selector not found', { passSelector });
    }
  } catch (e) {
    log(env, 'error', 'ensureLoggedIn: failed to type password', { error: e && e.message });
  }

  // Prepare watchers: navigation and optional success selector
  const navPromise = page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 }).catch(() => null);
  const successPromise = successSelector ? page.waitForSelector(successSelector, { timeout: 15000 }).catch(() => null) : Promise.resolve(null);

  // Click submit (best-effort) and wait for either navigation or success element
  try {
    // attempt to click the preferred submit selector
    log(env, 'debug', 'ensureLoggedIn: attempting to click submit', { submitSelector });
    await page.click(submitSelector).catch(() => null);
  } catch (e) {
    log(env, 'warn', 'ensureLoggedIn: click submit failed', { error: e && e.message });
  }

  // Special handling: detect Auth0's form_post response which renders a form that must be submitted to the callback URL
  try {
    const frames = page.frames();
    let submitted = false;
    for (const frame of frames) {
      try {
        const postForms = await frame.$$('form[method="post"]');
        if (!postForms || !postForms.length) continue;
        log(env, 'debug', 'ensureLoggedIn: found post forms in frame', { frame: frame.url(), count: postForms.length });
        for (const f of postForms) {
          try {
            const action = await frame.evaluate((form) => form.action || form.getAttribute('action'), f).catch(() => null);
            log(env, 'debug', 'ensureLoggedIn: post form action', { action, frame: frame.url() });
            const looksLikeCallback = action && (action.indexOf('callback') !== -1 || (expectedRedirectUrl && action.indexOf(expectedRedirectUrl) !== -1));
            if (looksLikeCallback || !expectedRedirectUrl) {
              log(env, 'info', 'ensureLoggedIn: submitting post form in frame', { action, frame: frame.url() });
              // submit the form in its frame context
              await frame.evaluate((form) => form.submit(), f).catch(() => null);
              await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }).catch(() => null);
              log(env, 'info', 'ensureLoggedIn: post form submitted and navigation complete', { url: page.url() });
              submitted = true;
              break;
            }
          } catch (e) {
            log(env, 'debug', 'ensureLoggedIn: error submitting a post form', { error: e && e.message });
          }
        }
      } catch (e) {
        // ignore frame-level errors
        log(env, 'debug', 'ensureLoggedIn: error scanning frame for post forms', { frame: frame.url(), error: e && e.message });
      }
      if (submitted) break;
    }
    if (!submitted) log(env, 'debug', 'ensureLoggedIn: no post forms submitted');
  } catch (e) {
    log(env, 'debug', 'ensureLoggedIn: error checking for post forms', { error: e && e.message });
  }

  // Wait for either navigation or a success selector to appear
  try {
    await Promise.race([navPromise, successPromise]);
  } catch (e) {
    // ignore - we'll continue to redirect detection below
  }

  // If an expected redirect URL was provided, wait for the page to reach it
  try {
    if (expectedRedirectUrl) {
      log(env, 'info', 'ensureLoggedIn: waiting for expected redirect URL', { expectedRedirectUrl });
      await page.waitForFunction(
        (expected) => window.location.href.indexOf(expected) === 0,
        { timeout: 30000 },
        expectedRedirectUrl
      );
      // wait briefly for network to settle
      await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 }).catch(() => null);
      log(env, 'info', 'ensureLoggedIn: expected redirect reached', { url: page.url() });
      return page.url();
    }

    // Otherwise wait until we're no longer on the login page (i.e., a redirect happened)
    log(env, 'debug', 'ensureLoggedIn: waiting for navigation away from loginUrl', { loginUrl });
    await page.waitForFunction((login) => window.location.href !== login, { timeout: 30000 }, loginUrl).catch(() => null);
    await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 }).catch(() => null);
    log(env, 'info', 'ensureLoggedIn: navigation after login complete', { url: page.url() });
  } catch (e) {
    log(env, 'warn', 'ensureLoggedIn: redirect wait failed or timed out', { error: e && e.message });
  }

  // Persist cookies to KV for reuse
  try {
    const cookies = await page.cookies();
    await env.BROWSER_KV_DEMO.put(cookieKey, JSON.stringify(cookies), { expirationTtl: 60 * 60 * 24 * 7 });
    log(env, 'info', 'ensureLoggedIn: saved cookies to KV', { cookieKey, count: cookies.length });
  } catch (e) {
    log(env, 'warn', 'ensureLoggedIn: failed to save cookies', { error: e && e.message });
  }
}

export default {
  async fetch(request, env) {
    const { searchParams } = new URL(request.url);
    log(env, 'info', 'fetch: incoming request', { url: request.url, method: request.method });
  // prefer query params, fall back to environment vars (set via .env for dev or wrangler vars/secrets)
  let url = searchParams.get("url") || env.TARGET_URL;
  const loginUrl = searchParams.get("login") || env.LOGIN_URL;
    const action = searchParams.get('action');
    // screenshot options (query params override env vars)
    const screenshotType = (searchParams.get('type') || env.SCREENSHOT_TYPE || 'jpeg').toLowerCase();
    const screenshotFullPage = (searchParams.get('fullPage') || env.SCREENSHOT_FULLPAGE || 'true') === 'true';
    const screenshotWidth = searchParams.get('width') ? Number(searchParams.get('width')) : (env.SCREENSHOT_WIDTH ? Number(env.SCREENSHOT_WIDTH) : undefined);
    const screenshotHeight = searchParams.get('height') ? Number(searchParams.get('height')) : (env.SCREENSHOT_HEIGHT ? Number(env.SCREENSHOT_HEIGHT) : undefined);
    const screenshotQuality = searchParams.get('quality') ? Number(searchParams.get('quality')) : (env.SCREENSHOT_QUALITY ? Number(env.SCREENSHOT_QUALITY) : undefined);
    let img;
    // Cookie-clear endpoint: ?action=clear-cookies&login=<loginUrl>
    if (action === 'clear-cookies') {
      if (!loginUrl) return new Response('Missing login URL for clearing cookies', { status: 400 });
      try {
        await env.BROWSER_KV_DEMO.delete(`cookies:${loginUrl}`);
        return new Response(`Cleared cookies for ${loginUrl}`, { status: 200 });
      } catch (e) {
        return new Response(`Failed to clear cookies: ${e.message}`, { status: 500 });
      }
    }
    if (url) {
      url = new URL(url).toString(); // normalize
      log(env, 'debug', 'fetch: checking KV for cached screenshot', { url });
      img = await env.BROWSER_KV_DEMO.get(url, { type: "arrayBuffer" });
      if (img === null) {
        log(env, 'info', 'fetch: launching browser');
        const browser = await puppeteer.launch(env.MYBROWSER);
        const page = await browser.newPage();
        // If a login URL was supplied and credentials exist, ensure we're logged in first
        if (loginUrl) {
          if (!env.LOGIN_USER || !env.LOGIN_PASS) {
            await browser.close();
            return new Response('Missing LOGIN_USER / LOGIN_PASS in environment', { status: 400 });
          }
          // Pass the desired final URL as the expected redirect target so ensureLoggedIn waits for it
          const finalAfterLogin = await ensureLoggedIn(page, env, loginUrl, `cookies:${loginUrl}`, url);
          // If ensureLoggedIn returned a different URL, use it as the page to screenshot
          const screenshotUrl = finalAfterLogin || url;
          log(env, 'debug', 'fetch: navigating to final screenshot URL', { screenshotUrl });
          await page.goto(screenshotUrl, { waitUntil: 'networkidle0' }).catch(() => null);
        } else {
          await page.goto(url);
        }
        img = await page.screenshot({
          type: screenshotType === 'png' ? 'png' : 'jpeg',
          fullPage: screenshotFullPage,
          quality: screenshotType === 'jpeg' ? (screenshotQuality || 80) : undefined,
          clip: (screenshotWidth && screenshotHeight) ? { x: 0, y: 0, width: screenshotWidth, height: screenshotHeight } : undefined,
        });
        try {
          await env.BROWSER_KV_DEMO.put(url, img, {
            expirationTtl: 60 * 60 * 24,
          });
          log(env, 'info', 'fetch: cached screenshot to KV', { url });
        } catch (e) {
          log(env, 'warn', 'fetch: failed to cache screenshot', { error: e && e.message });
        }
        await browser.close();
        log(env, 'info', 'fetch: browser closed');
      }
      log(env, 'info', 'fetch: returning screenshot', { url, size: img ? img.byteLength : 0 });
      return new Response(img, {
        headers: {
          "content-type": "image/jpeg",
        },
      });
    } else if (loginUrl) {
      // No explicit target URL provided but a login URL exists — perform login and screenshot the page after login
      const browser = await puppeteer.launch(env.MYBROWSER);
      const page = await browser.newPage();
      if (!env.LOGIN_USER || !env.LOGIN_PASS) {
        await browser.close();
        return new Response('Missing LOGIN_USER / LOGIN_PASS in environment', { status: 400 });
      }
      await ensureLoggedIn(page, env, loginUrl, `cookies:${loginUrl}`);
      const imgAfterLogin = await page.screenshot({
        type: screenshotType === 'png' ? 'png' : 'jpeg',
        fullPage: screenshotFullPage,
        quality: screenshotType === 'jpeg' ? (screenshotQuality || 80) : undefined,
        clip: (screenshotWidth && screenshotHeight) ? { x: 0, y: 0, width: screenshotWidth, height: screenshotHeight } : undefined,
      });
      await browser.close();
      return new Response(imgAfterLogin, { headers: { 'content-type': 'image/jpeg' } });
    } else {
      return new Response("Please add an ?url=https://example.com/ parameter or set TARGET_URL in your environment");
    }
  },
};

