import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const SOURCE_URL =
  process.env.SOURCE_WS_URL ??
  'wss://premws-pt1.365lpodds.com/zap/?uid=015800383588380318';
const SOURCE_PROTOCOL = process.env.SOURCE_WS_PROTOCOL ?? 'zap-protocol-v2';
const LOCAL_TARGET_URL = process.env.LOCAL_TARGET_WS_URL ?? '';
const OUTPUT_FILE = process.env.OUTPUT_FILE ?? 'messages.json';
const SOURCE_COOKIE_FILE = process.env.SOURCE_COOKIE_FILE ?? '';
const PING_INTERVAL_MS = Number(process.env.PING_INTERVAL_MS ?? 20_000);
const RECONNECT_DELAY_MS = Number(process.env.RECONNECT_DELAY_MS ?? 5_000);
const RECONNECT_ON_403 = process.env.RECONNECT_ON_403 === 'true';

const COOKIE_ATTRIBUTES = new Set([
  'path',
  'domain',
  'expires',
  'max-age',
  'secure',
  'httponly',
  'samesite',
  'priority',
  'partitioned',
]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const outputPath = path.resolve(__dirname, OUTPUT_FILE);

const parseCookiePairs = (rawCookie) => {
  const text = String(rawCookie ?? '').trim();
  if (!text) {
    return [];
  }

  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);

      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => {
            if (!item || typeof item !== 'object') {
              return null;
            }

            if (typeof item.name !== 'string' || typeof item.value !== 'string') {
              return null;
            }

            return `${item.name}=${item.value}`;
          })
          .filter(Boolean);
      }

      if (parsed && typeof parsed === 'object') {
        return Object.entries(parsed)
          .map(([name, value]) => {
            if (!name || value == null) {
              return null;
            }

            return `${name}=${String(value)}`;
          })
          .filter(Boolean);
      }
    } catch {
      // ignore and continue as plain string
    }
  }

  if (!text.includes('=') && /\s+/.test(text)) {
    const [name, ...parts] = text.split(/\s+/).filter(Boolean);
    if (name && parts.length > 0) {
      const value = parts.join(' ').replace(/^"|"$/g, '');
      return [`${name}=${value}`];
    }
  }

  return text
    .split(';')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .filter((pair) => {
      const separator = pair.indexOf('=');
      if (separator === -1) {
        return false;
      }

      const name = pair.slice(0, separator).trim().toLowerCase();
      return !COOKIE_ATTRIBUTES.has(name);
    });
};

const readCookieFromFile = async () => {
  if (!SOURCE_COOKIE_FILE) {
    return '';
  }

  try {
    const raw = await fs.readFile(path.resolve(__dirname, SOURCE_COOKIE_FILE), 'utf8');
    const parsed = parseCookiePairs(raw);
    return parsed.join('; ');
  } catch (error) {
    console.error(`[source] Failed to read SOURCE_COOKIE_FILE=${SOURCE_COOKIE_FILE}:`, error.message);
    return '';
  }
};

const sourceHeaders = {
  Origin: process.env.SOURCE_ORIGIN ?? 'https://www.bet365.com',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Accept-Language': process.env.SOURCE_ACCEPT_LANGUAGE ?? 'en-CA,en-US;q=0.9,en;q=0.8',
  'User-Agent':
    process.env.USER_AGENT ??
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0) Gecko/20100101 Firefox/148.0',
};

const refererHeader = process.env.SOURCE_REFERER;
if (refererHeader) {
  sourceHeaders.Referer = refererHeader;
}

const messages = [];
let flushQueue = Promise.resolve();
let shuttingDown = false;
let sourceSocket;
let localSocket;
let stopSourceReconnect = false;

const toPrintable = (text) =>
  text
    .replace(/\u0001/g, '<SOH>')
    .replace(/\u0002/g, '<STX>')
    .replace(/\u0003/g, '<ETX>')
    .replace(/\u0014/g, '<DC4>')
    .replace(/\u0016/g, '<SYN>');

const decodeLikelyBase64 = (candidate) => {
  try {
    const decoded = Buffer.from(candidate, 'base64').toString('utf8');
    if (!decoded) {
      return null;
    }

    const printableRatio =
      decoded.split('').filter((char) => /[\x09\x0A\x0D\x20-\x7E]/.test(char)).length / decoded.length;

    return printableRatio > 0.8 ? decoded : null;
  } catch {
    return null;
  }
};

const parseMessage = (rawText) => {
  const base64Matches = [...rawText.matchAll(/A_([A-Za-z0-9+/=]{50,})/g)].map((match) => match[1]);
  const decodedPayloads = base64Matches
    .map((encoded) => ({
      encoded,
      decoded: decodeLikelyBase64(encoded),
    }))
    .filter((item) => item.decoded);

  return {
    receivedAt: new Date().toISOString(),
    raw: rawText,
    printable: toPrintable(rawText),
    sections: rawText.split(/\u0001|\u0002|\u0003|\u0014|\u0016/).filter(Boolean),
    decodedPayloads,
  };
};

const flushMessages = async () => {
  flushQueue = flushQueue.then(async () => {
    await fs.writeFile(outputPath, JSON.stringify(messages, null, 2), 'utf8');
  });

  await flushQueue;
};

const scheduleReconnect = (label, connectFn) => {
  if (shuttingDown) {
    return;
  }

  console.log(`[${label}] Reconnecting in ${RECONNECT_DELAY_MS}ms...`);
  setTimeout(() => {
    if (!shuttingDown) {
      connectFn();
    }
  }, RECONNECT_DELAY_MS);
};

const forwardToLocal = (payload) => {
  if (!localSocket || localSocket.readyState !== WebSocket.OPEN) {
    return;
  }

  localSocket.send(JSON.stringify(payload));
};

const connectLocalSocket = () => {
  if (!LOCAL_TARGET_URL) {
    console.log('[local] Forwarding disabled (set LOCAL_TARGET_WS_URL to enable).');
    return;
  }

  localSocket = new WebSocket(LOCAL_TARGET_URL);

  localSocket.on('open', () => {
    console.log(`[local] Connected: ${LOCAL_TARGET_URL}`);
  });

  localSocket.on('error', (error) => {
    console.error('[local] WebSocket error:', error.message);
  });

  localSocket.on('close', (code, reasonBuffer) => {
    console.warn(`[local] Closed (code=${code}, reason=${reasonBuffer.toString()})`);
    scheduleReconnect('local', connectLocalSocket);
  });

  localSocket.on('pong', () => {
    console.log('[local] PONG received');
  });
};

const connectSourceSocket = async () => {
  if (!SOURCE_URL) {
    console.error(
      '[source] SOURCE_WS_URL is not set. Add a fresh URL from your authenticated bet365 browser session (wss://.../zap/?uid=...).',
    );
    return;
  }

  if (!SOURCE_URL.includes('uid=')) {
    console.error('[source] SOURCE_WS_URL is missing uid=... and is likely invalid.');
  }

  const cookieFromEnv = parseCookiePairs(process.env.SOURCE_COOKIE).join('; ');
  const cookieFromFile = await readCookieFromFile();
  const cookieHeader = cookieFromEnv || cookieFromFile;

  if (cookieHeader) {
    sourceHeaders.Cookie = cookieHeader;
    const cookieCount = cookieHeader.split(';').filter(Boolean).length;
    if (cookieCount < 2) {
      console.warn(
        '[source] Cookie header has very few entries. A single Cloudflare cookie (e.g. __cf_bm) is often not enough and may still return 403.',
      );
    }
  } else {
    delete sourceHeaders.Cookie;
  }

  sourceSocket = new WebSocket(SOURCE_URL, SOURCE_PROTOCOL, {
    headers: sourceHeaders,
    perMessageDeflate: true,
  });

  sourceSocket.on('open', () => {
    stopSourceReconnect = false;
    console.log(`[source] Connected: ${SOURCE_URL}`);
  });

  sourceSocket.on('pong', () => {
    console.log('[source] PONG received');
  });

  sourceSocket.on('message', async (data, isBinary) => {
    const rawText = isBinary ? data.toString('utf8') : data.toString();
    const parsed = parseMessage(rawText);
    messages.push(parsed);

    try {
      await flushMessages();
    } catch (error) {
      console.error('[file] Save error:', error.message);
    }

    forwardToLocal(parsed);
    console.log(`[source] Message saved and forwarded (${parsed.sections.length} sections)`);
  });

  sourceSocket.on('error', (error) => {
    if (error.message.includes('Unexpected server response: 403')) {
      stopSourceReconnect = !RECONNECT_ON_403;
      console.error(
        '[source] WebSocket error: 403 Forbidden. This usually means the uid expired or headers/cookies do not match a live browser session.',
      );

      if (stopSourceReconnect) {
        console.error('[source] Auto-reconnect disabled after 403. Set RECONNECT_ON_403=true to keep retrying.');
      }

      return;
    }

    console.error('[source] WebSocket error:', error.message);
  });

  sourceSocket.on('close', (code, reasonBuffer) => {
    console.warn(`[source] Closed (code=${code}, reason=${reasonBuffer.toString()})`);

    if (stopSourceReconnect) {
      return;
    }

    scheduleReconnect('source', connectSourceSocket);
  });
};

connectLocalSocket();
connectSourceSocket();

const heartbeat = setInterval(() => {
  if (sourceSocket?.readyState === WebSocket.OPEN) {
    sourceSocket.ping();
  }

  if (localSocket?.readyState === WebSocket.OPEN) {
    localSocket.ping();
  }
}, PING_INTERVAL_MS);

const shutdown = async () => {
  shuttingDown = true;
  clearInterval(heartbeat);
  sourceSocket?.close();
  localSocket?.close();

  try {
    await flushMessages();
  } catch (error) {
    console.error('[file] Save error during shutdown:', error.message);
  }

  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
