// Traffic amounts arrive either as a provider notice ("Осталось трафика: 12.5 ГБ")
// or as subscription-userinfo counters. Both are normalized to bytes so the
// source card and delivered node names can use one formatter.
const TRAFFIC_UNITS = {
  b: 1, 'б': 1,
  kb: 1024, kib: 1024, 'кб': 1024,
  mb: 1024 ** 2, mib: 1024 ** 2, 'мб': 1024 ** 2,
  gb: 1024 ** 3, gib: 1024 ** 3, 'гб': 1024 ** 3,
  tb: 1024 ** 4, tib: 1024 ** 4, 'тб': 1024 ** 4
};

const TRAFFIC_NOTICE_PATTERN = /(?:осталось(?:\s+трафика)?|остаток\s+трафика|remaining(?:\s+traffic)?|traffic\s+left|剩余流量|剩余)\s*[:：=\-]?\s*(\d+(?:[.,]\d+)?)\s*(tib|tb|gib|gb|mib|mb|kib|kb|тб|гб|мб|кб|b|б)(?![a-zа-яё])/iu;

function parseTrafficNotice(text) {
  const match = TRAFFIC_NOTICE_PATTERN.exec(String(text || ''));
  if (!match) return null;
  const value = Number(match[1].replace(',', '.'));
  const multiplier = TRAFFIC_UNITS[match[2].toLowerCase()];
  if (!Number.isFinite(value) || value < 0 || !multiplier) return null;
  return Math.round(value * multiplier);
}

function remainingTrafficBytes(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  if (Number.isFinite(metadata.remaining_traffic) && metadata.remaining_traffic >= 0) return Math.round(metadata.remaining_traffic);
  if (Number.isFinite(metadata.total) && metadata.total > 0) {
    return Math.max(0, Math.round(metadata.total - (Number(metadata.upload) || 0) - (Number(metadata.download) || 0)));
  }
  return null;
}

function formatTraffic(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  for (const [unit, size] of [['TB', 1024 ** 4], ['GB', 1024 ** 3], ['MB', 1024 ** 2], ['KB', 1024]]) {
    if (bytes >= size) return `${Math.round((bytes / size) * 10) / 10} ${unit}`;
  }
  return `${Math.round(bytes)} B`;
}

function remainingTrafficLabel(metadata) {
  return formatTraffic(remainingTrafficBytes(metadata));
}

module.exports = { parseTrafficNotice, remainingTrafficBytes, formatTraffic, remainingTrafficLabel };
