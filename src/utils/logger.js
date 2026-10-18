function write(level, message, fields = {}) {
  const entry = { time: new Date().toISOString(), level, message, ...fields };
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

module.exports = {
  info: (message, fields) => write('info', message, fields),
  warn: (message, fields) => write('warn', message, fields),
  error: (message, fields) => write('error', message, fields)
};
