/**
 * Cloudflare Worker for Nyora Web Parsers
 *
 * CORS proxy for fetching HTML from manga sites + an image proxy that bypasses
 * hotlink protection. Locked to the Nyora web app's origins.
 */

// ── Access control ──────────────────────────────────────────────────────────
// Only these origins may use the proxy. Enforced via the Origin header (fetch,
// e.g. /proxy) and the Referer header (<img> loads, e.g. /image).
//
// This stops other *websites* from using the worker (the browser sends their
// real Origin/Referer, which won't match). It does NOT stop a determined script
// that spoofs these headers — for hard limits add a Cloudflare **Rate limiting**
// rule on the worker (dash → Workers & Pages → nyora-cors-proxy → Settings →
// Triggers/Rate limiting) or a shared secret. Add custom domains to this list.
const ALLOWED_ORIGINS = [
  "https://nyoraweb.pages.dev",
  "http://127.0.0.1:3000",
  "http://localhost:3000",
];

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const host = new URL(origin).hostname;
    // Cloudflare Pages preview deploys: <hash>.nyoraweb.pages.dev
    return host === "nyoraweb.pages.dev" || host.endsWith(".nyoraweb.pages.dev");
  } catch {
    return false;
  }
}

// The caller's origin from Origin (fetch) or Referer (<img>), if allowed; else null.
function allowedCaller(request) {
  const origin = request.headers.get("Origin");
  if (origin) return isAllowedOrigin(origin) ? origin : null;
  const referer = request.headers.get("Referer");
  if (referer) {
    try {
      const refOrigin = new URL(referer).origin;
      if (isAllowedOrigin(refOrigin)) return refOrigin;
    } catch {}
  }
  return null;
}

function forbidden() {
  return new Response("Forbidden: origin not allowed", { status: 403 });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const allowed = allowedCaller(request);

    // CORS preflight
    if (request.method === "OPTIONS") {
      if (!allowed) return forbidden();
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": allowed,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, Origin",
          "Access-Control-Max-Age": "86400",
          "Vary": "Origin",
        },
      });
    }

    // Info root stays open (no proxying = no abuse vector).
    if (url.pathname !== "/proxy" && url.pathname !== "/image") {
      return new Response("Nyora Web Parsers Proxy API. Use /proxy?url=... or /image?u=...", { status: 200 });
    }

    // Anything that actually proxies is gated to allowed origins.
    if (!allowed) return forbidden();

    if (url.pathname === "/proxy") return await handleHtmlProxy(request, url, allowed);
    return await handleImageProxy(request, url, allowed);
  },
};

async function handleHtmlProxy(request, workerUrl, allowedOrigin) {
  const targetUrl = workerUrl.searchParams.get("url");

  if (!targetUrl) {
    return new Response("Missing 'url' parameter", { status: 400, headers: { "Access-Control-Allow-Origin": allowedOrigin } });
  }

  try {
    const target = new URL(targetUrl);
    const proxyHeaders = new Headers();
    proxyHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36");
    proxyHeaders.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8");
    proxyHeaders.set("Accept-Language", "en-US,en;q=0.5");
    proxyHeaders.set("Accept-Encoding", "identity");
    proxyHeaders.set("Cache-Control", "no-cache");
    proxyHeaders.set("Referer", target.origin + "/");

    let body = null;
    if (request.method === "POST") {
      proxyHeaders.set("Content-Type", request.headers.get("Content-Type") || "application/x-www-form-urlencoded");
      proxyHeaders.set("Origin", target.origin);
      proxyHeaders.set("X-Requested-With", "XMLHttpRequest");
      // Buffer the body since we are in a Worker and may need to re-read it
      body = await request.arrayBuffer();
    }

    const response = await fetchWithRedirects(targetUrl, {
      method: request.method,
      headers: proxyHeaders,
      body: body
    });

    const contentType = response.headers.get("Content-Type") || "";
    const isTextResponse =
      contentType.includes("text/") ||
      contentType.includes("application/json") ||
      contentType.includes("application/javascript") ||
      contentType.includes("application/xml") ||
      contentType.includes("application/xhtml+xml");
    const responseBody = isTextResponse ? await response.text() : await response.arrayBuffer();

    const responseHeaders = new Headers(response.headers);
    responseHeaders.set("Access-Control-Allow-Origin", allowedOrigin);
    responseHeaders.set("Vary", "Origin");
    responseHeaders.set("X-Final-URL", response.url);
    responseHeaders.set("X-Redirected", response.url !== targetUrl ? "1" : "0");

    // Expose the header to the browser
    responseHeaders.set("Access-Control-Expose-Headers", "X-Final-URL, X-Redirected");

    // Strip headers that interfere with client-side parsing
    responseHeaders.delete("Content-Security-Policy");
    responseHeaders.delete("X-Frame-Options");
    responseHeaders.delete("Content-Encoding");
    responseHeaders.delete("Content-Length");

    return new Response(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    });

  } catch (err) {
    return new Response(JSON.stringify({
        error: "Proxy Error: " + err.message,
        url: targetUrl,
        stack: err.stack
    }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": allowedOrigin
      }
    });
  }
}

async function handleImageProxy(request, workerUrl, allowedOrigin) {
  const targetUrl = workerUrl.searchParams.get("u");

  if (!targetUrl) {
    return new Response("Missing 'u' parameter", { status: 400, headers: { "Access-Control-Allow-Origin": allowedOrigin } });
  }

  try {
    const target = new URL(targetUrl);
    const proxyHeaders = new Headers();
    proxyHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36");
    proxyHeaders.set("Accept", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8");
    proxyHeaders.set("Accept-Language", "en-US,en;q=0.5");
    proxyHeaders.set("Accept-Encoding", "identity");
    proxyHeaders.set("Referer", target.origin + "/");

    // Apply caller-supplied headers (&h=Name:Value), overriding defaults.
    for (const raw of workerUrl.searchParams.getAll("h")) {
      const colon = raw.indexOf(":");
      if (colon > 0) proxyHeaders.set(raw.slice(0, colon), raw.slice(colon + 1));
    }

    const response = await fetchWithRedirects(targetUrl, {
      method: "GET",
      headers: proxyHeaders
    });

    const body = await response.arrayBuffer();

    const responseHeaders = new Headers(response.headers);
    responseHeaders.set("Access-Control-Allow-Origin", allowedOrigin);
    responseHeaders.set("Vary", "Origin");
    responseHeaders.set("X-Final-URL", response.url);
    responseHeaders.set("X-Redirected", response.url !== targetUrl ? "1" : "0");
    responseHeaders.set("Access-Control-Expose-Headers", "X-Final-URL, X-Redirected");
    responseHeaders.delete("Content-Security-Policy");
    responseHeaders.delete("X-Frame-Options");
    responseHeaders.delete("Content-Encoding");
    responseHeaders.delete("Content-Length");
    if (!responseHeaders.get("Content-Type")) {
      const lowerUrl = targetUrl.toLowerCase();
      if (lowerUrl.endsWith(".webp")) responseHeaders.set("Content-Type", "image/webp");
      else if (lowerUrl.endsWith(".jpg") || lowerUrl.endsWith(".jpeg")) responseHeaders.set("Content-Type", "image/jpeg");
      else if (lowerUrl.endsWith(".png")) responseHeaders.set("Content-Type", "image/png");
      else if (lowerUrl.endsWith(".gif")) responseHeaders.set("Content-Type", "image/gif");
    }

    return new Response(body, {
      status: response.status,
      headers: responseHeaders
    });

  } catch (err) {
    return new Response(JSON.stringify({
        error: "Image Proxy Error: " + err.message,
        u: targetUrl
    }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": allowedOrigin
      }
    });
  }
}

async function fetchWithRedirects(url, init, maxRedirects = 8) {
  let currentUrl = url;
  let currentInit = {
    ...init,
    headers: new Headers(init.headers || {}),
    redirect: "manual",
  };

  for (let i = 0; i <= maxRedirects; i++) {
    const response = await fetch(currentUrl, currentInit);
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return response;
    }

    const location = response.headers.get("Location");
    if (!location) return response;

    const nextUrl = new URL(location, currentUrl).href;
    const next = new URL(nextUrl);
    const headers = new Headers(currentInit.headers || {});
    // Preserve the caller/source Referer across redirects — hotlink-protected
    // image CDNs gate on the SOURCE-SITE Referer, so resetting it to the
    // redirect URL (the CDN's own host) trips the 403. Only set one if absent.
    if (!headers.has("Referer")) headers.set("Referer", currentUrl);
    if (currentInit.method && currentInit.method !== "GET") {
      headers.set("Origin", next.origin);
      headers.set("X-Requested-With", "XMLHttpRequest");
    }

    currentUrl = nextUrl;
    currentInit = {
      ...currentInit,
      headers,
      redirect: "manual",
    };

    if (response.status === 303) {
      currentInit.method = "GET";
      currentInit.body = undefined;
      headers.delete("Content-Type");
    }
  }

  throw new Error("Too many redirects");
}
