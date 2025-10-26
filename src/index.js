/**
 * Browser Worker - Auth0 Login and Screenshot Service
 *
 * This Cloudflare Worker automates login to Auth0-protected sites and takes screenshots.
 * It uses Puppeteer to control a headless browser, handles session cookies via KV storage,
 * and supports various configuration options for different login flows.
 *
 * Usage:
 * - Run `npm run dev` to start development server
 * - Run `npm run deploy` to publish to production
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { Stagehand } from "@browserbasehq/stagehand";
import { endpointURLString } from "@cloudflare/playwright";

// Utility function to mask sensitive data in logs
function maskSecrets(key, value) {
  if (!key) return value;
  const secretKeys = ['LOGIN_PASS', 'LOGIN_USER', 'password', 'passwd'];
  if (secretKeys.includes(key.toString().toUpperCase())) return '****';
  return value;
}

// Logging utility with configurable debug level and secret masking
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

// Main login function that handles cookie restoration and fresh login
async function ensureLoggedIn(page, env, loginUrl, cookieKey, expectedRedirectUrl = null) {
  log(env, 'debug', 'ensureLoggedIn: attempting to restore cookies', { cookieKey });

  // Phase 1: Try to restore existing session from KV storage
  try {
    const saved = await env.BROWSER_KV_DEMO.get(cookieKey);
    if (saved) {
      log(env, 'debug', 'ensureLoggedIn: found saved cookies', { cookieKey });
      const cookies = JSON.parse(saved);
      if (cookies && cookies.length) {
        await page.setCookie(...cookies);
        log(env, 'debug', 'ensureLoggedIn: set cookies on page', { count: cookies.length });

        // Test if session is still valid by navigating to login page
        await page.goto(loginUrl, { waitUntil: 'networkidle0' });
        log(env, 'debug', 'ensureLoggedIn: navigated to loginUrl to validate session', { loginUrl });

        // Check for success indicators to confirm we're logged in
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
    // Cookie restore failed - proceed to fresh login
    log(env, 'warn', 'ensureLoggedIn: cookie restore failed, will attempt fresh login', { error: e && e.message });
  }

  // Phase 2: Perform fresh login if session restoration failed
  // Configure selectors for form fields (customizable via environment variables)
  const userSelector = env.LOGIN_USER_SELECTOR || 'input[name="email"], input[name="username"], #username';
  const passSelector = env.LOGIN_PASS_SELECTOR || 'input[name="password"], #password';
  const submitSelector = env.LOGIN_SUBMIT_SELECTOR || '.auth0-lock-submit, button[type="submit"], #\\31 -submit';
  const successSelector = env.LOGIN_SUCCESS_SELECTOR || null;

  log(env, 'info', 'ensureLoggedIn: navigating to login page', { loginUrl });
  await page.goto(loginUrl, { waitUntil: 'networkidle0' });

  // Wait for Auth0 Lock UI to load (optional, for Auth0 sites)
  try {
    await page.waitForSelector('.auth0-lock-container', { timeout: 5000 });
  } catch (e) {
    // Ignore if not an Auth0 site - continue with form detection
  }

  // Wait for login form inputs to be available
  try {
    await page.waitForSelector(userSelector, { timeout: 15000 });
  } catch (e) {
    console.warn('username selector not found within timeout:', userSelector);
  }

  // Fill in login credentials
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

  // Set up watchers for login completion: either navigation or success element appearing
  const navPromise = page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 }).catch(() => null);
  const successPromise = successSelector ? page.waitForSelector(successSelector, { timeout: 15000 }).catch(() => null) : Promise.resolve(null);

  // Submit the login form
  try {
    log(env, 'debug', 'ensureLoggedIn: attempting to click submit', { submitSelector });
    await page.click(submitSelector).catch(() => null);
  } catch (e) {
    log(env, 'warn', 'ensureLoggedIn: click submit failed', { error: e && e.message });
  }

  // Handle Auth0's form_post response mode (common in OAuth flows)
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

            // Check if this looks like an OAuth callback form
            const looksLikeCallback = action && (action.indexOf('callback') !== -1 || (expectedRedirectUrl && action.indexOf(expectedRedirectUrl) !== -1));
            if (looksLikeCallback || !expectedRedirectUrl) {
              log(env, 'info', 'ensureLoggedIn: submitting post form in frame', { action, frame: frame.url() });
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
        log(env, 'debug', 'ensureLoggedIn: error scanning frame for post forms', { frame: frame.url(), error: e && e.message });
      }
      if (submitted) break;
    }
    if (!submitted) log(env, 'debug', 'ensureLoggedIn: no post forms submitted');
  } catch (e) {
    log(env, 'debug', 'ensureLoggedIn: error checking for post forms', { error: e && e.message });
  }

  // Wait for login completion: either navigation or success element
  try {
    await Promise.race([navPromise, successPromise]);
  } catch (e) {
    log(env, 'debug', 'ensureLoggedIn: race condition resolved, continuing');
  }

  // Handle final redirect to target application
  try {
    if (expectedRedirectUrl) {
      log(env, 'info', 'ensureLoggedIn: waiting for expected redirect URL', { expectedRedirectUrl });
      await page.waitForFunction(
        (expected) => window.location.href.indexOf(expected) === 0,
        { timeout: 30000 },
        expectedRedirectUrl
      );
      await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 }).catch(() => null);
      log(env, 'info', 'ensureLoggedIn: expected redirect reached', { url: page.url() });
      return page.url();
    }

    // Default: wait for navigation away from login page
    log(env, 'debug', 'ensureLoggedIn: waiting for navigation away from loginUrl', { loginUrl });
    await page.waitForFunction((login) => window.location.href !== login, { timeout: 30000 }, loginUrl).catch(() => null);
    await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 }).catch(() => null);
    log(env, 'info', 'ensureLoggedIn: navigation after login complete', { url: page.url() });
  } catch (e) {
    log(env, 'warn', 'ensureLoggedIn: redirect wait failed or timed out', { error: e && e.message });
  }

  // Save session cookies to KV for future requests (7-day TTL)
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
    // Main request handler - processes screenshot requests with optional login
    const { searchParams } = new URL(request.url);
    log(env, 'info', 'fetch: incoming request', { url: request.url, method: request.method });

    // Parse query parameters with environment fallbacks
    let url = searchParams.get("url") || env.TARGET_URL;
    const loginUrl = searchParams.get("login") || env.LOGIN_URL;
    const action = searchParams.get('action');
    const nocache = searchParams.get('nocache');
    // Configure screenshot options (query params override environment variables)
    const screenshotType = (searchParams.get('type') || env.SCREENSHOT_TYPE || 'jpeg').toLowerCase();
    const screenshotFullPage = (searchParams.get('fullPage') || env.SCREENSHOT_FULLPAGE || 'true') === 'true';
    const screenshotWidth = searchParams.get('width') ? Number(searchParams.get('width')) : (env.SCREENSHOT_WIDTH ? Number(env.SCREENSHOT_WIDTH) : undefined);
    const screenshotHeight = searchParams.get('height') ? Number(searchParams.get('height')) : (env.SCREENSHOT_HEIGHT ? Number(env.SCREENSHOT_HEIGHT) : undefined);
    const screenshotQuality = searchParams.get('quality') ? Number(searchParams.get('quality')) : (env.SCREENSHOT_QUALITY ? Number(env.SCREENSHOT_QUALITY) : undefined);
    let img;
    // Handle special actions like clearing cookies
    if (action === 'clear-cookies') {
      if (!loginUrl) return new Response('Missing login URL for clearing cookies', { status: 400 });
      try {
        await env.BROWSER_KV_DEMO.delete(`cookies:${loginUrl}`);
        return new Response(`Cleared cookies for ${loginUrl}`, { status: 200 });
      } catch (e) {
        return new Response(`Failed to clear cookies: ${e.message}`, { status: 500 });
      }
    }
    // Main screenshot logic: check cache or generate fresh screenshot
    if (url) {
      url = new URL(url).toString(); // normalize URL

      // Check for cached screenshot unless nocache is requested
      if (!nocache) {
        log(env, 'debug', 'fetch: checking KV for cached screenshot', { url });
        img = await env.BROWSER_KV_DEMO.get(url, { type: "arrayBuffer" });
      } else {
        img = null; // force fresh screenshot when nocache is set
      }

      // Generate fresh screenshot if not cached
      if (img === null) {
        log(env, 'info', 'fetch: initializing Stagehand for fresh screenshot');
        const stagehand = new Stagehand({
          env: "LOCAL",
          localBrowserLaunchOptions: { cdpUrl: endpointURLString(env.BROWSER) },
          verbose: 1,
          enableCaching: false,
        });
        await stagehand.init();
        const page = stagehand.page;
        log(env, 'debug', 'fetch: Stagehand initialized, page ready');
        // Handle login if required, then navigate to target page
        if (loginUrl) {
          if (!env.LOGIN_USER || !env.LOGIN_PASS) {
            await browser.close();
            return new Response('Missing LOGIN_USER / LOGIN_PASS in environment', { status: 400 });
          }
          // Perform login and wait for redirect to target URL
          const finalAfterLogin = await ensureLoggedIn(page, env, loginUrl, `cookies:${loginUrl}`, url);
          const screenshotUrl = finalAfterLogin || url;
          log(env, 'debug', 'fetch: navigating to final screenshot URL', { screenshotUrl });
          await page.goto(screenshotUrl, { waitUntil: 'networkidle0' }).catch(() => null);
        } else {
          // No login required - navigate directly to target URL
          await page.goto(url);
        }
        // Capture the screenshot with configured options
        log(env, 'debug', 'fetch: taking screenshot', { url, type: screenshotType, fullPage: screenshotFullPage });
        img = await page.screenshot({
          type: screenshotType === 'png' ? 'png' : 'jpeg',
          fullPage: screenshotFullPage,
          quality: screenshotType === 'jpeg' ? (screenshotQuality || 80) : undefined,
          clip: (screenshotWidth && screenshotHeight) ? { x: 0, y: 0, width: screenshotWidth, height: screenshotHeight } : undefined,
        });
        log(env, 'debug', 'fetch: screenshot taken', { size: img ? img.length : 0 });
        // Skip caching screenshots - always generate fresh ones
        log(env, 'info', 'fetch: screenshot caching disabled');
         await stagehand.close();
         log(env, 'info', 'fetch: Stagehand closed');
      }
      log(env, 'info', 'fetch: returning screenshot', { url, size: img ? img.byteLength : 0 });
      return new Response(img, {
        headers: {
          "content-type": "image/jpeg",
        },
      });
    } else if (loginUrl) {
      // Login-only mode: perform login and screenshot the resulting page
      const stagehand = new Stagehand({
        env: "LOCAL",
        localBrowserLaunchOptions: { cdpUrl: endpointURLString(env.BROWSER) },
        verbose: 1,
        enableCaching: false,
      });
      await stagehand.init();
      const page = stagehand.page;
      if (!env.LOGIN_USER || !env.LOGIN_PASS) {
        await stagehand.close();
        return new Response('Missing LOGIN_USER / LOGIN_PASS in environment', { status: 400 });
      }
      await ensureLoggedIn(page, env, loginUrl, `cookies:${loginUrl}`);
      const imgAfterLogin = await page.screenshot({
        type: screenshotType === 'png' ? 'png' : 'jpeg',
        fullPage: screenshotFullPage,
        quality: screenshotType === 'jpeg' ? (screenshotQuality || 80) : undefined,
        clip: (screenshotWidth && screenshotHeight) ? { x: 0, y: 0, width: screenshotWidth, height: screenshotHeight } : undefined,
      });
      await stagehand.close();
      return new Response(imgAfterLogin, { headers: { 'content-type': 'image/jpeg' } });
    } else {
      // No URL or login specified - return help message
      return new Response("Please add an ?url=https://example.com/ parameter or set TARGET_URL in your environment");
    }
  },
};

