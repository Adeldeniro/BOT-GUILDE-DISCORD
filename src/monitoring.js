const logger = require('./logger');

let processHooksInstalled = false;

function installProcessMonitoring() {
  if (processHooksInstalled) return;
  processHooksInstalled = true;

  process.on('warning', (warning) => {
    logger.warn('[process] warning', warning);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('[process] unhandledRejection', {
      reason,
      promiseType: promise?.constructor?.name || typeof promise,
    });
  });

  process.on('uncaughtException', (error) => {
    logger.fatal('[process] uncaughtException', error);
    process.exit(1);
  });

  process.on('beforeExit', (code) => {
    logger.info('[process] beforeExit', { code });
  });

  process.on('exit', (code) => {
    logger.info('[process] exit', { code });
  });

  process.on('SIGINT', () => {
    logger.warn('[process] SIGINT received');
  });

  process.on('SIGTERM', () => {
    logger.warn('[process] SIGTERM received');
  });
}

function attachClientMonitoring(client) {
  client.on('warn', (message) => {
    logger.warn('[discord] client warn', { message });
  });

  client.on('error', (error) => {
    logger.error('[discord] client error', error);
  });

  client.on('invalidated', () => {
    logger.error('[discord] session invalidated');
  });

  client.on('shardDisconnect', (event, shardId) => {
    logger.warn('[discord] shard disconnect', {
      shardId,
      code: event?.code,
      reason: event?.reason,
      wasClean: event?.wasClean,
    });
  });

  client.on('shardError', (error, shardId) => {
    logger.error('[discord] shard error', { shardId, error });
  });

  client.on('shardReconnecting', (shardId) => {
    logger.warn('[discord] shard reconnecting', { shardId });
  });

  client.on('shardResume', (replayedEvents, shardId) => {
    logger.info('[discord] shard resumed', { shardId, replayedEvents });
  });

  if (client.rest?.on) {
    client.rest.on('rateLimited', (info) => {
      logger.warn('[discord] rate limited', info);
    });
  }
}

function startHeartbeat(client) {
  const intervalSec = Math.max(30, Number(process.env.HEARTBEAT_INTERVAL_SECONDS || 300));
  const timer = setInterval(() => {
    const guildCount = client.guilds?.cache?.size ?? null;
    const ping = Number.isFinite(client.ws?.ping) ? client.ws.ping : null;
    logger.info('[heartbeat] alive', logger.runtimeSnapshot({
      guildCount,
      wsPingMs: ping,
      readyAt: client.readyAt ? client.readyAt.toISOString() : null,
    }));
  }, intervalSec * 1000);

  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = {
  installProcessMonitoring,
  attachClientMonitoring,
  startHeartbeat,
};
