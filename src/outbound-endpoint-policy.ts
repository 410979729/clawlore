import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { domainToASCII } from "node:url";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";

export interface OutboundEndpointPolicy {
  /**
   * Exact hostnames or IP literals that may resolve to a non-public address.
   * Wildcards are deliberately unsupported.
   */
  allowedPrivateHosts: string[];
}

type ResolveHost = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

export interface OutboundEndpointDependencies {
  fetch?: typeof globalThis.fetch;
  resolveHost?: ResolveHost;
}

const MAX_ALLOWED_PRIVATE_HOSTS = 32;
function stripIpv6Brackets(value: string): string {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

function normalizeHost(value: string): string {
  const trimmed = stripIpv6Brackets(value.trim().toLowerCase()).replace(/\.$/u, "");
  if (!trimmed || trimmed.includes("*") || /[/\\@?#\s%]/u.test(trimmed)) {
    throw new Error("CLAWLORE_OUTBOUND_ENDPOINT_INVALID_HOST");
  }
  if (isIP(trimmed) !== 0) return trimmed;
  const ascii = domainToASCII(trimmed);
  if (!ascii || ascii.length > 253 || ascii.split(".").some((label) => !label || label.length > 63)) {
    throw new Error("CLAWLORE_OUTBOUND_ENDPOINT_INVALID_HOST");
  }
  return ascii.toLowerCase();
}

function ipv4Number(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
}

function inIpv4Cidr(value: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

function isPublicIpv4(address: string): boolean {
  const value = ipv4Number(address);
  if (value === null) return false;
  const blocked: Array<[string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  return !blocked.some(([base, prefix]) => inIpv4Cidr(value, ipv4Number(base)!, prefix));
}

function isPublicIpv6(address: string): boolean {
  const normalized = stripIpv6Brackets(address).toLowerCase();
  const mapped = normalized.match(/^(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/u);
  if (mapped) return isPublicIpv4(mapped[1]);
  if (normalized === "::" || normalized === "::1") return false;
  if (/^(?:fc|fd)/u.test(normalized) || /^fe[89ab]/u.test(normalized) || /^ff/u.test(normalized)) {
    return false;
  }
  if (/^2001:db8:/u.test(normalized) || /^2001:0:/u.test(normalized) || /^2002:/u.test(normalized)) {
    return false;
  }
  return /^[23][0-9a-f]{3}:/u.test(normalized);
}

function isPublicAddress(address: string): boolean {
  const family = isIP(stripIpv6Brackets(address));
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export function parseOutboundEndpointPolicy(value: unknown): OutboundEndpointPolicy {
  if (value === undefined) return { allowedPrivateHosts: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("outboundEndpointPolicy must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => key !== "allowedPrivateHosts")) {
    throw new Error("outboundEndpointPolicy contains unsupported fields");
  }
  if (raw.allowedPrivateHosts !== undefined && !Array.isArray(raw.allowedPrivateHosts)) {
    throw new Error("outboundEndpointPolicy.allowedPrivateHosts must be an array");
  }
  const values = (raw.allowedPrivateHosts ?? []) as unknown[];
  if (values.length > MAX_ALLOWED_PRIVATE_HOSTS) {
    throw new Error(`outboundEndpointPolicy supports at most ${MAX_ALLOWED_PRIVATE_HOSTS} hosts`);
  }
  const normalized = values.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(`outboundEndpointPolicy.allowedPrivateHosts[${index}] must be a hostname`);
    }
    return normalizeHost(entry);
  });
  return { allowedPrivateHosts: [...new Set(normalized)].sort() };
}

export function validateOutboundEndpointSyntax(
  value: string,
  policy: OutboundEndpointPolicy,
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("CLAWLORE_OUTBOUND_ENDPOINT_INVALID_URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("CLAWLORE_OUTBOUND_ENDPOINT_UNSAFE_URL");
  }
  const hostname = normalizeHost(url.hostname);
  const privateHostAllowed = policy.allowedPrivateHosts.includes(hostname);
  if (url.protocol !== "https:" && !privateHostAllowed) {
    throw new Error("CLAWLORE_OUTBOUND_ENDPOINT_HTTPS_REQUIRED");
  }
  if (isIP(hostname) !== 0 && !isPublicAddress(hostname) && !privateHostAllowed) {
    throw new Error("CLAWLORE_OUTBOUND_ENDPOINT_PRIVATE_ADDRESS_BLOCKED");
  }
  if ((hostname === "localhost" || hostname.endsWith(".localhost")) && !privateHostAllowed) {
    throw new Error("CLAWLORE_OUTBOUND_ENDPOINT_PRIVATE_ADDRESS_BLOCKED");
  }
  return url;
}

async function resolveAllowedAddresses(
  hostname: string,
  policy: OutboundEndpointPolicy,
  resolveHost: ResolveHost = async (hostname) =>
    lookup(hostname, { all: true, verbatim: true }),
): Promise<Array<{ address: string; family: number }>> {
  if (isIP(hostname) !== 0) {
    return [{ address: hostname, family: isIP(hostname) }];
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await resolveHost(hostname);
  } catch {
    throw new Error("CLAWLORE_OUTBOUND_ENDPOINT_DNS_FAILED");
  }
  const normalizedAddresses = addresses.map((entry) => ({
    address: stripIpv6Brackets(entry.address),
    family: isIP(stripIpv6Brackets(entry.address)),
  }));
  if (
    normalizedAddresses.length === 0
    || normalizedAddresses.some((entry) => entry.family === 0)
  ) {
    throw new Error("CLAWLORE_OUTBOUND_ENDPOINT_DNS_FAILED");
  }
  if (
    !policy.allowedPrivateHosts.includes(hostname)
    && normalizedAddresses.some((entry) => !isPublicAddress(entry.address))
  ) {
    throw new Error("CLAWLORE_OUTBOUND_ENDPOINT_PRIVATE_ADDRESS_BLOCKED");
  }
  return normalizedAddresses;
}

export async function assertOutboundEndpointAllowed(
  value: string,
  policy: OutboundEndpointPolicy,
  resolveHost: ResolveHost = async (hostname) =>
    lookup(hostname, { all: true, verbatim: true }),
): Promise<URL> {
  const url = validateOutboundEndpointSyntax(value, policy);
  const hostname = normalizeHost(url.hostname);
  await resolveAllowedAddresses(hostname, policy, resolveHost);
  return url;
}

function createValidatedLookup(
  policy: OutboundEndpointPolicy,
  resolveHost: ResolveHost,
): LookupFunction {
  return (hostname, options, callback) => {
    const normalizedHostname = normalizeHost(hostname);
    resolveAllowedAddresses(normalizedHostname, policy, resolveHost).then((resolved) => {
      const addresses = [...new Map(resolved.map((entry) =>
        [entry.address, entry])).values()].filter((entry) =>
        entry.family !== 0
        && (!options.family || options.family === entry.family));
      if (addresses.length === 0) {
        throw new Error("CLAWLORE_OUTBOUND_ENDPOINT_DNS_FAILED");
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    }).catch((error: unknown) => {
      const failure = error instanceof Error
        ? error
        : new Error("CLAWLORE_OUTBOUND_ENDPOINT_DNS_FAILED");
      callback(failure as NodeJS.ErrnoException, options.all ? [] : "", 0);
    });
  };
}

/**
 * Validate every request at dispatch time and perform DNS validation inside
 * the socket lookup used for the connection. The validated address is the one
 * that is connected, closing the usual check-then-resolve rebinding window.
 * Redirects are rejected so a public endpoint cannot bounce credentials into
 * a private or link-local service.
 */
export function createSafeOutboundFetch(
  policy: OutboundEndpointPolicy | undefined,
  dependencies: OutboundEndpointDependencies = {},
): typeof globalThis.fetch {
  const effectivePolicy = policy ?? { allowedPrivateHosts: [] };
  const resolveHost = dependencies.resolveHost ?? (async (hostname: string) =>
    lookup(hostname, { all: true, verbatim: true }));
  const dispatcher = dependencies.fetch
    ? null
    : new Agent({ connect: { lookup: createValidatedLookup(effectivePolicy, resolveHost) } });
  return async (input, init) => {
    const url = validateOutboundEndpointSyntax(requestUrl(input), effectivePolicy);
    let response: Response;
    if (dependencies.fetch) {
      await assertOutboundEndpointAllowed(url.toString(), effectivePolicy, resolveHost);
      response = await dependencies.fetch(input, { ...init, redirect: "manual" });
    } else {
      const requestInit = {
        ...init,
        redirect: "manual",
        dispatcher: dispatcher as Dispatcher,
      } as unknown as Parameters<typeof undiciFetch>[1];
      response = await undiciFetch(
        input as unknown as Parameters<typeof undiciFetch>[0],
        requestInit,
      ) as unknown as Response;
    }
    if (response.status >= 300 && response.status <= 399) {
      await response.body?.cancel().catch(() => {});
      throw new Error("CLAWLORE_OUTBOUND_ENDPOINT_REDIRECT_BLOCKED");
    }
    return response;
  };
}
