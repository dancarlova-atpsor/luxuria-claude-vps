// Logger simplu — stdout JSON (citit de journalctl pe VPS).

function log(level, message, fields = {}) {
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    msg: message,
    ...fields,
  });
  // eslint-disable-next-line no-console
  console.log(line);
}

export const logInfo  = (msg, f) => log('info',  msg, f);
export const logWarn  = (msg, f) => log('warn',  msg, f);
export const logError = (msg, f) => log('error', msg, f);
