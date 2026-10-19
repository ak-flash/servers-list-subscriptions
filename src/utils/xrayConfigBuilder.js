const { SubscriptionError } = require('./subscriptionErrors');
const { vlessCapability } = require('./protocolParsers');

function range(value) {
  const match = /^(\d+)(?:-(\d+))?$/.exec(String(value));
  if (!match) throw new SubscriptionError('invalid_link');
  return { from: Number(match[1]), to: Number(match[2] || match[1]) };
}

function buildFinalmask(node) {
  if (!node.finalmask) return null;
  const tcp = node.finalmask.tcp.map(mask => {
    const settings = mask.settings;
    const delay = range(settings.delays[0]);
    const lengths = range(settings.lengths[0]);
    const split = range(settings.maxSplit || '0');
    return {
      type: mask.type,
      settings: {
        packets: settings.packets || '',
        length: settings.lengths[0],
        delay: settings.delays[0],
        maxSplit: settings.maxSplit || '0'
      }
    };
  });
  return { tcp, udp: node.finalmask.udp || [], quicParams: node.finalmask.quicParams || null };
}

function buildXhttpSettings(node) {
  const settings = { host: node.xhttp.host, path: node.xhttp.path, mode: node.xhttp.mode };
  if (node.xhttp.extra?.host) settings.host = node.xhttp.extra.host;
  if (node.xhttp.extra?.path) settings.path = node.xhttp.extra.path;
  if (node.xhttp.extra?.mode) settings.mode = node.xhttp.extra.mode;
  const extra = node.xhttp.extra || {};
  const fields = [
    'xPaddingBytes', 'xPaddingObfsMode', 'xPaddingKey', 'xPaddingHeader', 'xPaddingPlacement', 'xPaddingMethod',
    'uplinkHTTPMethod', 'sessionPlacement', 'sessionKey', 'seqPlacement', 'seqKey', 'uplinkDataPlacement',
    'uplinkDataKey', 'uplinkChunkSize', 'noGRPCHeader', 'noSSEHeader', 'scMaxEachPostBytes', 'scMinPostsIntervalMs',
    'scMaxBufferedPosts', 'scStreamUpServerSecs', 'serverMaxHeaderBytes'
  ];
  const aliases = { sessionIDPlacement: 'sessionPlacement', sessionIDKey: 'sessionKey' };
  for (const field of fields) {
    if (extra[field] !== undefined && extra[field] !== '' && extra[field] !== 0 && extra[field] !== '0') settings[field] = extra[field];
  }
  for (const [from, to] of Object.entries(aliases)) {
    if (extra[from] !== undefined && extra[from] !== '') settings[to] = extra[from];
  }
  if (extra.xmux && typeof extra.xmux === 'object') {
    settings.xmux = {};
    for (const field of ['maxConcurrency', 'maxConnections', 'cMaxReuseTimes', 'hMaxRequestTimes', 'hMaxReusableSecs', 'hKeepAlivePeriod']) {
      if (extra.xmux[field] !== undefined && extra.xmux[field] !== '' && extra.xmux[field] !== 0 && extra.xmux[field] !== '0') settings.xmux[field] = extra.xmux[field];
    }
  }
  return settings;
}

function buildHttpProxyOutbound(proxy) {
  const outbound = {
    tag: 'probe-http-proxy',
    protocol: 'http',
    settings: { servers: [{ address: proxy.address, port: proxy.port }] }
  };
  if (proxy.user) outbound.settings.servers[0].users = [{ user: proxy.user, pass: proxy.pass }];
  if (proxy.protocol === 'https') {
    outbound.streamSettings = { security: 'tls', tlsSettings: { serverName: proxy.address } };
  }
  return outbound;
}

function buildXrayConfig(node, address, port, credentials, certificateAuthority, httpProxy = null) {
  const support = vlessCapability(node);
  if (support.capability !== 'supported') throw new SubscriptionError(support.capability === 'invalid' ? 'invalid_link' : 'unsupported');
  const streamSettings = { network: node.network, security: node.security };
  if (node.security === 'tls') {
    const tlsSettings = { serverName: node.sni };
    if (certificateAuthority) {
      tlsSettings.disableSystemRoot = true;
      tlsSettings.certificates = [{ usage: 'verify', certificate: certificateAuthority.toString().trim().split(/\r?\n/) }];
    }
    if (node.alpn.length) tlsSettings.alpn = node.alpn;
    if (node.fingerprint) tlsSettings.fingerprint = node.fingerprint;
    streamSettings.tlsSettings = tlsSettings;
  } else if (node.security === 'reality') {
    streamSettings.realitySettings = {
      serverName: node.sni, fingerprint: node.fingerprint,
      // Xray 26 uses "password" for the X25519 public key; VLESS URIs still use "pbk".
      password: node.reality.publicKey, shortId: node.reality.shortId, spiderX: node.reality.spiderX
    };
    if (node.reality.mldsa65Verify) streamSettings.realitySettings.mldsa65Verify = node.reality.mldsa65Verify;
  }
  if (node.network === 'ws') streamSettings.wsSettings = { path: node.ws.path, headers: { Host: node.ws.host } };
  if (node.network === 'xhttp') streamSettings.xhttpSettings = buildXhttpSettings(node);
  if (node.network === 'grpc') streamSettings.grpcSettings = { serviceName: node.grpc.serviceName, multiMode: node.grpc.mode === 'multi' };
  if (node.finalmask) streamSettings.finalmask = buildFinalmask(node);
  const outbounds = [{
    tag: 'probe-vpn', protocol: 'vless',
    settings: { vnext: [{ address, port: node.port, users: [{ id: node.uuid, encryption: node.encryption, flow: node.flow }] }] },
    streamSettings, mux: { enabled: false }
  }];
  if (httpProxy) {
    const proxyOutbound = buildHttpProxyOutbound(httpProxy);
    streamSettings.sockopt = { dialerProxy: proxyOutbound.tag };
    outbounds.push(proxyOutbound);
  }
  return {
    log: { loglevel: 'none' },
    inbounds: [{
      tag: 'probe-in', listen: '127.0.0.1', port, protocol: 'socks',
      settings: { auth: 'password', accounts: [{ user: credentials.user, pass: credentials.password }], udp: false }
    }],
    outbounds,
    routing: { rules: [{ type: 'field', inboundTag: ['probe-in'], outboundTag: 'probe-vpn' }] }
  };
}

module.exports = { buildXrayConfig };
