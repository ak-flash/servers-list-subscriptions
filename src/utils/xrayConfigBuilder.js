const { SubscriptionError } = require('./subscriptionErrors');
const { vlessCapability } = require('./protocolParsers');

function buildXrayConfig(node, address, port, credentials, certificateAuthority) {
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
  if (node.network === 'xhttp') streamSettings.xhttpSettings = { host: node.xhttp.host, path: node.xhttp.path, mode: node.xhttp.mode };
  return {
    log: { loglevel: 'none' },
    inbounds: [{
      tag: 'probe-in', listen: '127.0.0.1', port, protocol: 'socks',
      settings: { auth: 'password', accounts: [{ user: credentials.user, pass: credentials.password }], udp: false }
    }],
    outbounds: [{
      tag: 'probe-vpn', protocol: 'vless',
      settings: { vnext: [{ address, port: node.port, users: [{ id: node.uuid, encryption: node.encryption, flow: node.flow }] }] },
      streamSettings, mux: { enabled: false }
    }],
    routing: { rules: [{ type: 'field', inboundTag: ['probe-in'], outboundTag: 'probe-vpn' }] }
  };
}

module.exports = { buildXrayConfig };
