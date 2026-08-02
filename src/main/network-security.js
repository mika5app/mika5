'use strict';

const dns = require('dns').promises;
const https = require('https');
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
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4D) return 'image/bmp';
  return null;
}

function safeImageExtensionFromMime(mimeType) {
  return {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/bmp': 'bmp'
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
    return allZero || loopback || uniqueLocal || linkLocal || multicast;
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

async function fetchElectronImage(input, options = {}) {
  const fetchImpl = options.fetchImpl;
  if (typeof fetchImpl !== 'function') throw downloadError('DOWNLOAD_UNKNOWN');
  const lookup = options.lookup || dns.lookup;
  const maxBytes = options.maxBytes || DOWNLOAD_MAX_BYTES;
  const maxRedirects = Number.isInteger(options.maxRedirects) ? options.maxRedirects : 5;
  const timeoutMs = options.timeoutMs || 30000;
  const startedAt = Date.now();
  let current = input;
  let redirects = 0;

  while (true) {
    const destination = await validateElectronDownloadDestination(current, lookup);
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) throw downloadError('DOWNLOAD_TIMEOUT');
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, remainingMs);
    let response;
    let buffer;
    try {
      response = await fetchImpl(destination.url.toString(), {
        method: 'GET',
        redirect: 'manual',
        headers: {
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          'Accept-Encoding': 'identity',
          'User-Agent': `MIKA5/${options.appVersion || '0.0.0'}`
        },
        signal: controller.signal
      });
      const status = Number(response?.status || 0);
      if (DOWNLOAD_REDIRECT_STATUSES.has(status)) {
        const location = responseHeader(response, 'location');
        if (!location) throw downloadError('DOWNLOAD_HTTP_STATUS');
        if (redirects >= maxRedirects) throw downloadError('DOWNLOAD_TOO_MANY_REDIRECTS');
        redirects += 1;
        current = new URL(location, destination.url);
        continue;
      }
      if (status < 200 || status >= 300) throw downloadError('DOWNLOAD_HTTP_STATUS');
      const declaredLength = Number(responseHeader(response, 'content-length') || 0);
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw downloadError('DOWNLOAD_TOO_LARGE');
      }
      const arrayBuffer = await response.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
    } catch (error) {
      if (error instanceof ImageDownloadError) throw error;
      if (timedOut || error?.name === 'AbortError') throw downloadError('DOWNLOAD_TIMEOUT');
      throw downloadError('DOWNLOAD_NETWORK_FAILED');
    } finally {
      clearTimeout(timer);
    }
    if (buffer.length > maxBytes) throw downloadError('DOWNLOAD_TOO_LARGE');
    const mimeType = detectImageMimeFromBuffer(buffer);
    if (!mimeType || !safeImageExtensionFromMime(mimeType)) {
      throw downloadError('DOWNLOAD_INVALID_IMAGE');
    }
    return { buffer, mimeType, finalUrl: destination.url };
  }
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
