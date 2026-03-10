import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const SOURCE_URL = process.env.SOURCE_WS_URL ?? 'wss://premws-pt1.365lpodds.com/zap/?uid=015800383588380318';
const SOURCE_PROTOCOL = process.env.SOURCE_WS_PROTOCOL ?? 'zap-protocol-v2';
const LOCAL_TARGET_URL = process.env.LOCAL_TARGET_WS_URL ?? 'ws://127.0.0.1:8585';
const OUTPUT_FILE = process.env.OUTPUT_FILE ?? 'messages.json';
const PING_INTERVAL_MS = Number(process.env.PING_INTERVAL_MS ?? 20_000);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const outputPath = path.resolve(__dirname, OUTPUT_FILE);

const sourceHeaders = {
  Origin: 'https://www.bet365.com',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8,uk;q=0.7',
  'User-Agent':
    process.env.USER_AGENT ??
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
};

const messages = [];
let flushQueue = Promise.resolve();

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

const localSocket = new WebSocket(LOCAL_TARGET_URL);

localSocket.on('open', () => {
  console.log(`[local] Connected: ${LOCAL_TARGET_URL}`);
});

localSocket.on('error', (error) => {
  console.error('[local] WebSocket error:', error.message);
});

localSocket.on('close', (code, reasonBuffer) => {
  console.warn(`[local] Closed (code=${code}, reason=${reasonBuffer.toString()})`);
});

localSocket.on('pong', () => {
  console.log('[local] PONG received');
});

const sourceSocket = new WebSocket(SOURCE_URL, SOURCE_PROTOCOL, {
  headers: sourceHeaders,
  perMessageDeflate: true,
});

sourceSocket.on('open', () => {
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

  if (localSocket.readyState === WebSocket.OPEN) {
    localSocket.send(JSON.stringify(parsed));
  }

  console.log(`[source] Message saved and forwarded (${parsed.sections.length} sections)`);
});

sourceSocket.on('error', (error) => {
  console.error('[source] WebSocket error:', error.message);
});

sourceSocket.on('close', (code, reasonBuffer) => {
  console.warn(`[source] Closed (code=${code}, reason=${reasonBuffer.toString()})`);
});

const heartbeat = setInterval(() => {
  if (sourceSocket.readyState === WebSocket.OPEN) {
    sourceSocket.ping();
  }

  if (localSocket.readyState === WebSocket.OPEN) {
    localSocket.ping();
  }
}, PING_INTERVAL_MS);

const shutdown = async () => {
  clearInterval(heartbeat);
  sourceSocket.close();
  localSocket.close();

  try {
    await flushMessages();
  } catch (error) {
    console.error('[file] Save error during shutdown:', error.message);
  }

  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
