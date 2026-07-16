const fs = require('fs');
const os = require('os');
const path = require('path');

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

const configuredLevel = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const minLevel = LEVELS[configuredLevel] || LEVELS.info;
const logToFile = String(process.env.LOG_TO_FILE || 'true').toLowerCase() !== 'false';
const logDir = path.resolve(__dirname, '..', process.env.LOG_DIR || 'logs');

function timestamp() {
  return new Date().toISOString();
}

function todayKey() {
  return timestamp().slice(0, 10);
}

function serializeError(error) {
  if (!error) return null;
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: error.code,
    signal: error.signal,
  };
}

function sanitize(value) {
  if (value instanceof Error) return serializeError(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;

  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = sanitize(entry);
  }
  return out;
}

function formatLine(level, message, meta) {
  const parts = [`[${timestamp()}]`, `[${level.toUpperCase()}]`, message];
  if (meta && Object.keys(meta).length) {
    parts.push(JSON.stringify(meta));
  }
  return parts.join(' ');
}

function writeLine(line) {
  try {
    process.stdout.write(`${line}\n`);
  } catch {}

  if (!logToFile) return;

  try {
    fs.mkdirSync(logDir, { recursive: true });
    const filePath = path.join(logDir, `bot-${todayKey()}.log`);
    fs.appendFileSync(filePath, `${line}\n`, 'utf8');
  } catch {}
}

function log(level, message, meta = null) {
  if ((LEVELS[level] || 0) < minLevel) return;
  writeLine(formatLine(level, message, sanitize(meta)));
}

function runtimeSnapshot(extra = {}) {
  const mem = process.memoryUsage();
  return {
    pid: process.pid,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    uptimeSec: Math.round(process.uptime()),
    rssMb: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
    heapUsedMb: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
    heapTotalMb: Math.round((mem.heapTotal / 1024 / 1024) * 10) / 10,
    ...extra,
  };
}

module.exports = {
  debug(message, meta) {
    log('debug', message, meta);
  },
  info(message, meta) {
    log('info', message, meta);
  },
  warn(message, meta) {
    log('warn', message, meta);
  },
  error(message, meta) {
    log('error', message, meta);
  },
  fatal(message, meta) {
    log('fatal', message, meta);
  },
  serializeError,
  runtimeSnapshot,
};
