'use strict';

const dns = require('dns').promises;
const https = require('https');
const http = require('http');
const tls = require('tls');
const { Readable } = require('stream');
const net = require('net');

function detectImageMimeFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= 8
    && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'image/jpeg';
  if (buffer.length >= 12
    && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer.length >= 6 && /^(GIF87a|GIF89a)$/.test(buffer.toString('ascii', 0, 6))) return 'image/gif';
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4D) return 'image/bmp';
  return null;
}

function safeImageExtensionFromMime(mimeType) {
  return {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/gif': 'gif'
  }[String(mimeType || '').toLowerCase()] || null;
}

const DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

class ImageDownloadError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ImageDownloadError';
    this.code = code;
  }
}

function downloadError(code) {
  return new ImageDownloadError(code);
}

function ipv4ToNumber(address) {
  return address.split('.').reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
}

function inIpv4Range(value, base, bits) {
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
  return (value & mask) === (ipv4ToNumber(base) & mask);
}

function ipv6Bytes(address) {
  let value = address.toLowerCase().split('%')[0];
  const mappedIpv4 = value.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedIpv4) {
    const number = ipv4ToNumber(mappedIpv4[2]);
    value = `${mappedIpv4[1]}${((number >>> 16) & 0xFFFF).toString(16)}:${(number & 0xFFFF).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const fill = 8 - left.length - right.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const groups = [...left, ...Array(fill).fill('0'), ...right];
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.flatMap(group => {
    const number = parseInt(group, 16);
    return [(number >>> 8) & 0xFF, number & 0xFF];
  });
}

function isBlockedIp(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const value = ipv4ToNumber(address);
    return [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['127.0.0.0', 8], ['100.64.0.0', 10],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
      ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
      ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4],
      ['240.0.0.0', 4]
    ].some(([base, bits]) => inIpv4Range(value, base, bits));
  }
  if (family === 6) {
    const bytes = ipv6Bytes(address);
    if (!bytes) return true;
    const allZero = bytes.every(byte => byte === 0);
    const loopback = bytes.slice(0, 15).every(byte => byte === 0) && bytes[15] === 1;
    const uniqueLocal = (bytes[0] & 0xFE) === 0xFC;
    const linkLocal = bytes[0] === 0xFE && (bytes[1] & 0xC0) === 0x80;
    const multicast = bytes[0] === 0xFF;
    const mapped = bytes.slice(0, 10).every(byte => byte === 0)
      && bytes[10] === 0xFF && bytes[11] === 0xFF;
    if (mapped) return isBlockedIp(bytes.slice(12).join('.'));
    const globalUnicast = (bytes[0] & 0xE0) === 0x20;
    const transitionOrDocumentation = (bytes[0] === 0x20 && bytes[1] === 0x02)
      || (bytes[0] === 0x20 && bytes[1] === 0x01
        && ((bytes[2] === 0 && bytes[3] === 0) || (bytes[2] === 0x0D && bytes[3] === 0xB8)));
    return allZero || loopback || uniqueLocal || linkLocal || multicast || !globalUnicast || transitionOrDocumentation;
  }
  return true;
}

function validateHttpsUrl(input) {
  const parsed = input instanceof URL ? new URL(input.toString()) : new URL(String(input || ''));
  if (parsed.protocol !== 'https:') throw new Error('Solo se permiten imágenes HTTPS seguras');
  if (parsed.username || parsed.password) throw new Error('No se permiten credenciales en la URL');
  if (parsed.hostname.toLowerCase() === 'localhost') throw new Error('Destino interno bloqueado');
  return parsed;
}

async function resolvePublicDestination(input, lookup = dns.lookup) {
  const url = validateHttpsUrl(input);
  const normalizedHostname = url.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = net.isIP(normalizedHostname);
  const addresses = literalFamily
    ? [{ address: normalizedHostname, family: literalFamily }]
    : await lookup(normalizedHostname, { all: true, verbatim: true });
  if (!Array.isArray(addresses) || addresses.length === 0) throw new Error('El host no resolvió');
  if (addresses.some(entry => isBlockedIp(entry.address))) throw new Error('Destino interno bloqueado');
  const selected = addresses[0];
  return {
    url,
    hostname: normalizedHostname,
    address: selected.address,
    family: selected.family,
    addresses
  };
}

async function validateElectronDownloadDestination(input, lookup = dns.lookup) {
  let url;
  try {
    url = input instanceof URL ? new URL(input.toString()) : new URL(String(input || ''));
  } catch (_) {
    throw downloadError('DOWNLOAD_BLOCKED_DESTINATION');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const isLocalName = hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || (!net.isIP(hostname) && !hostname.includes('.'));
  if (url.protocol !== 'https:' || url.username || url.password || isLocalName) {
    throw downloadError('DOWNLOAD_BLOCKED_DESTINATION');
  }
  let addresses;
  const literalFamily = net.isIP(hostname);
  if (literalFamily) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch (_) {
      throw downloadError('DOWNLOAD_DNS_FAILED');
    }
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw downloadError('DOWNLOAD_DNS_FAILED');
  }
  if (addresses.some(entry => !entry?.address || isBlockedIp(entry.address))) {
    throw downloadError('DOWNLOAD_BLOCKED_DESTINATION');
  }
  return { url, addresses };
}

function responseHeader(response, name) {
  if (response?.headers && typeof response.headers.get === 'function') {
    return response.headers.get(name);
  }
  const headers = response?.headers || {};
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

// Each connection uses the validated IP; HTTP Host, SNI and certificate
// verification retain the original hostname. A system HTTP(S) proxy receives
// CONNECT <validated IP>, so it cannot resolve the destination a second time.
async function fetchPinnedImage(_url, options) {
  const proxyRules = options.resolveProxy ? await options.resolveProxy(options.destination.url.href) : 'DIRECT';
  const rules = String(proxyRules).split(';').map(rule => rule.trim());
  for (let i = 0; i < rules.length; i++) {
    options.signal.throwIfAborted();
    try {
      return await fetchPinnedRoute(options, rules[i]);
    } catch (error) {
      // Only a failed connection to the proxy permits the next configured
      // route. Never invent DIRECT or bypass authentication/TLS failures.
      if (error.code !== 'DOWNLOAD_PROXY_CONNECTION_FAILED' || i === rules.length - 1) throw error;
    }
  }
}

async function fetchPinnedRoute(options, rule) {
  const { destination, signal } = options;
  const url = destination.url;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const address = destination.addresses[0];
  signal.throwIfAborted();
  const agent = new https.Agent({ keepAlive: false });
  let tunnel;
  const closeTunnel = () => tunnel?.destroy();
  const systemCAs = typeof tls.getCACertificates === 'function' ? tls.getCACertificates('system') : [];
  const ca = systemCAs.length ? [...tls.getCACertificates('default'), ...systemCAs] : undefined;
  try {
    if (rule !== 'DIRECT') {
      const match = /^(PROXY|HTTPS) ([^\s/]+)$/.exec(rule);
      if (!match) throw downloadError('DOWNLOAD_PROXY_UNSUPPORTED');
      const proxy = new URL(`${match[1] === 'HTTPS' ? 'https' : 'http'}://${match[2]}`);
      if (proxy.username || proxy.password) throw downloadError('DOWNLOAD_PROXY_UNSUPPORTED');
      const authority = `${address.family === 6 ? `[${address.address}]` : address.address}:${url.port || 443}`;
      tunnel = await new Promise((resolve, reject) => {
        const request = (proxy.protocol === 'https:' ? https : http).request(proxy, {
          method: 'CONNECT', path: authority, headers: { Host: authority }, signal, ca
        });
        request.on('error', error => {
          const unavailable = ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT'];
          reject(unavailable.includes(error.code) ? downloadError('DOWNLOAD_PROXY_CONNECTION_FAILED') : error);
        });
        request.on('connect', (response, tunnel, head) => {
          if (response.statusCode !== 200 || head.length) {
            tunnel.destroy();
            reject(downloadError(response.statusCode === 407 ? 'DOWNLOAD_PROXY_AUTH_REQUIRED' : 'DOWNLOAD_NETWORK_FAILED'));
          } else resolve(tunnel);
        });
        request.end();
      });
      signal.addEventListener('abort', closeTunnel, { once: true });
      signal.throwIfAborted();
      agent.createConnection = connectionOptions => tls.connect({ ...connectionOptions, socket: tunnel, ca });
    }
    return await new Promise((resolve, reject) => {
      const request = https.request(url, {
        method: 'GET', headers: options.headers, signal, agent, ca,
        servername: net.isIP(hostname) ? undefined : hostname,
        lookup: (_name, lookupOptions, callback) => {
          if (lookupOptions?.all) callback(null, destination.addresses);
          else callback(null, address.address, address.family);
        }
      }, response => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Readable.toWeb(response, {
          // Count bytes, not chunks, in the adapter's own prefetch queue.
          strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength }
        }),
        dispose() {
          signal.removeEventListener('abort', closeTunnel);
          response.destroy(); request.destroy(); agent.destroy(); closeTunnel();
        }
      }));
      request.on('error', reject);
      request.end();
    });
  } catch (error) {
    signal.removeEventListener('abort', closeTunnel);
    closeTunnel();
    agent.destroy();
    throw error;
  }
}

async function fetchElectronImage(input, options = {}) {
  const fetchImpl = options.fetchImpl || fetchPinnedImage;
  const lookup = options.lookup || dns.lookup;
  const maxBytes = options.maxBytes || DOWNLOAD_MAX_BYTES;
  const maxRedirects = Number.isInteger(options.maxRedirects) ? options.maxRedirects : 5;
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(downloadError('DOWNLOAD_TIMEOUT'));
    }, options.timeoutMs || 30000);
  });
  const work = async () => {
    let current = input;
    for (let redirects = 0; ; redirects++) {
      const destination = await validateElectronDownloadDestination(current, lookup);
      controller.signal.throwIfAborted();
      let response;
      let reader;
      const cancelReader = () => { reader?.cancel().catch(() => {}); };
      try {
        response = await fetchImpl(destination.url.toString(), {
          method: 'GET', redirect: 'manual', destination, resolveProxy: options.resolveProxy,
          headers: {
            Accept: 'image/png,image/jpeg,image/webp,image/gif,image/bmp',
            'Accept-Encoding': 'identity', 'User-Agent': `MIKA5/${options.appVersion || '0.0.0'}`
          }, signal: controller.signal
        });
        const status = Number(response?.status || 0);
        if (DOWNLOAD_REDIRECT_STATUSES.has(status)) {
          const location = responseHeader(response, 'location');
          if (!location) throw downloadError('DOWNLOAD_HTTP_STATUS');
          if (redirects >= maxRedirects) throw downloadError('DOWNLOAD_TOO_MANY_REDIRECTS');
          current = new URL(location, destination.url);
          continue;
        }
        if (status < 200 || status >= 300) throw downloadError('DOWNLOAD_HTTP_STATUS');
        const declaredLength = Number(responseHeader(response, 'content-length') || 0);
        if (declaredLength > maxBytes) throw downloadError('DOWNLOAD_TOO_LARGE');
        if (!response.body?.getReader) throw downloadError('DOWNLOAD_INVALID_IMAGE');
        reader = response.body.getReader();
        controller.signal.addEventListener('abort', cancelReader, { once: true });
        const chunks = [];
        let total = 0;
        while (true) {
          const { done, value } = await reader.read();
          controller.signal.throwIfAborted();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) throw downloadError('DOWNLOAD_TOO_LARGE');
          chunks.push(Buffer.from(value));
        }
        const buffer = Buffer.concat(chunks, total);
        const mimeType = detectImageMimeFromBuffer(buffer);
        if (!mimeType) throw downloadError('DOWNLOAD_INVALID_IMAGE');
        return { buffer, mimeType, finalUrl: destination.url };
      } finally {
        controller.signal.removeEventListener('abort', cancelReader);
        // Cancel unread redirect/error bodies as well as partial streams.
        if (reader) { reader.cancel().catch(() => {}); reader.releaseLock(); }
        else response?.body?.cancel().catch(() => {});
        response?.dispose?.();
      }
    }
  };
  try {
    return await Promise.race([work(), timeout]);
  } catch (error) {
    if (controller.signal.aborted) throw downloadError('DOWNLOAD_TIMEOUT');
    if (error instanceof ImageDownloadError) throw error;
    throw downloadError('DOWNLOAD_NETWORK_FAILED');
  } finally { clearTimeout(timer); controller.abort(); }
}

async function downloadAndSaveElectronImage(input, options = {}) {
  const downloaded = await fetchElectronImage(input, options);
  const extension = safeImageExtensionFromMime(downloaded.mimeType);
  const requestedName = String(options.suggestedName || 'imagen-mika5')
    .split(/[\\/]/).pop()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 120);
  const baseName = requestedName.replace(/\.[A-Za-z0-9]{1,8}$/, '') || 'imagen-mika5';
  const safeName = `${baseName}.${extension}`;
  const dialogResult = await options.showSaveDialog({
    defaultPath: options.joinPath(options.downloadsPath, safeName),
    filters: [{ name: 'Imagen', extensions: [extension] }]
  });
  if (dialogResult?.canceled || !dialogResult?.filePath) {
    return { ok: false, canceled: true };
  }
  await options.writeFile(dialogResult.filePath, downloaded.buffer);
  return { ok: true, path: dialogResult.filePath };
}

function requestPinned(destination, requestImpl, timeoutMs, maxBytes) {
  return new Promise((resolve, reject) => {
    const request = requestImpl({
      protocol: 'https:',
      hostname: destination.hostname,
      port: destination.url.port || 443,
      path: `${destination.url.pathname}${destination.url.search}`,
      method: 'GET',
      servername: destination.hostname,
      headers: { Host: destination.url.host },
      lookup: (_hostname, _options, callback) => {
        callback(null, destination.address, destination.family);
      }
    }, response => {
      const chunks = [];
      let total = 0;
      response.on('data', chunk => {
        total += chunk.length;
        if (total > maxBytes) {
          request.destroy(new Error('La imagen excede el límite de 50 MB'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        status: response.statusCode || 0,
        headers: response.headers || {},
        buffer: Buffer.concat(chunks)
      }));
      response.on('error', reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Timeout de descarga')));
    request.on('error', reject);
    request.end();
  });
}

async function downloadHttpsPinned(input, options = {}) {
  const lookup = options.lookup || dns.lookup;
  const requestImpl = options.requestImpl || https.request;
  const maxRedirects = Number.isInteger(options.maxRedirects) ? options.maxRedirects : 5;
  const maxBytes = options.maxBytes || 50 * 1024 * 1024;
  const timeoutMs = options.timeoutMs || 30000;
  let current = validateHttpsUrl(input);

  for (let redirects = 0; ; redirects += 1) {
    const destination = await resolvePublicDestination(current, lookup);
    const response = await requestPinned(destination, requestImpl, timeoutMs, maxBytes);
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      if (redirects >= maxRedirects) throw new Error('Demasiadas redirecciones');
      current = validateHttpsUrl(new URL(response.headers.location, current));
      continue;
    }
    return { ...response, finalUrl: current.toString(), destination };
  }
}

module.exports = {
  detectImageMimeFromBuffer,
  safeImageExtensionFromMime,
  isBlockedIp,
  validateHttpsUrl,
  resolvePublicDestination,
  validateElectronDownloadDestination,
  fetchElectronImage,
  downloadAndSaveElectronImage,
  ImageDownloadError,
  downloadHttpsPinned
};
