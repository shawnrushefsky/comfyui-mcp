import { lookup } from "dns/promises";
import { isIP } from "net";

const MAX_REDIRECTS = 5;

/**
 * True if `ip` falls in a range that must never be reachable from
 * URL-fetching tools. These tools accept attacker/LLM-supplied URLs, so
 * without this check a caller could direct the server to make requests to
 * loopback, RFC1918 private space, or link-local addresses - which
 * includes 169.254.169.254, the cloud metadata endpoint on AWS/GCP/Azure.
 */
function isForbiddenIp(ip: string): boolean {
  const version = isIP(ip);

  if (version === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 127) return true; // loopback
    if (a === 10) return true; // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 0) return true; // "this" network
    return false;
  }

  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true; // loopback / unspecified
    if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
      return true; // fe80::/10 link-local
    }
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 unique local
    if (lower.startsWith("::ffff:")) {
      // IPv4-mapped IPv6 address - unwrap and check the embedded v4 address
      const v4 = lower.slice("::ffff:".length);
      if (isIP(v4) === 4) return isForbiddenIp(v4);
    }
    return false;
  }

  // Not a recognizable IP literal - caller should have resolved it first.
  return true;
}

export class UnsafeUrlError extends Error {}

async function assertUrlIsSafe(urlStr: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new UnsafeUrlError(`Invalid URL: ${urlStr}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError(`Unsupported URL scheme: ${url.protocol}`);
  }

  const hostname = url.hostname;

  if (hostname.toLowerCase() === "localhost") {
    throw new UnsafeUrlError("Refusing to fetch localhost");
  }

  if (isIP(hostname)) {
    if (isForbiddenIp(hostname)) {
      throw new UnsafeUrlError(`Refusing to fetch internal/private address: ${hostname}`);
    }
    return;
  }

  // Resolve DNS and check every returned address. This is best-effort, not
  // a hard guarantee against a DNS-rebinding attacker who changes the
  // record between this check and the actual connection - but it stops the
  // straightforward case of a URL that points directly at an internal host.
  let addresses: string[];
  try {
    const results = await lookup(hostname, { all: true, verbatim: true });
    addresses = results.map((r) => r.address);
  } catch {
    throw new UnsafeUrlError(`Could not resolve host: ${hostname}`);
  }

  if (addresses.length === 0) {
    throw new UnsafeUrlError(`Could not resolve host: ${hostname}`);
  }

  for (const addr of addresses) {
    if (isForbiddenIp(addr)) {
      throw new UnsafeUrlError(
        `Refusing to fetch ${hostname}: resolves to internal/private address ${addr}`
      );
    }
  }
}

/**
 * fetch() wrapper for URLs that come from tool input (an LLM, an MCP
 * client, or anything else outside our control) rather than a hardcoded
 * constant. Blocks loopback/private/link-local targets - including the
 * cloud metadata endpoint - and re-validates on every redirect hop instead
 * of trusting fetch's automatic redirect following, which would otherwise
 * let a malicious server bounce the request to an internal address after
 * the initial check passed.
 */
export async function safeFetch(urlStr: string, init: RequestInit = {}): Promise<Response> {
  let currentUrl = urlStr;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    await assertUrlIsSafe(currentUrl);

    const response = await fetch(currentUrl, { ...init, redirect: "manual" });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return response;
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return response;
  }

  throw new UnsafeUrlError(`Too many redirects fetching ${urlStr}`);
}
