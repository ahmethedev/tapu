// Preloaded with `node --import` by the security tests. Blocks and reports
// every outbound connection except TAPU_NET_ALLOW ("host:port,..."), every
// listening server socket, UDP, and fetch. Reports go to stderr as
// `TAPU_NET_GUARD <kind> <target>` lines.
import dgram from 'node:dgram';
import net from 'node:net';

const allowed = new Set((process.env.TAPU_NET_ALLOW ?? '').split(',').filter(Boolean));
const report = (kind, target) => process.stderr.write(`TAPU_NET_GUARD ${kind} ${target}\n`);

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // net.connect() passes one normalized [options, callback] array; pg calls connect(port, host).
  let first = Array.isArray(args[0]) ? args[0][0] : args[0];
  let target;
  if (first && typeof first === 'object') {
    target = first.path ? `unix:${first.path}` : `${first.host ?? 'localhost'}:${first.port}`;
  } else if (typeof first === 'number' || /^\d+$/.test(String(first))) {
    target = `${typeof args[1] === 'string' ? args[1] : 'localhost'}:${first}`;
  } else {
    target = `unix:${first}`;
  }
  if (allowed.has(target)) return connect.apply(this, args);
  report('connect', target);
  process.nextTick(() => this.destroy(new Error(`net-guard: blocked connection to ${target}`)));
  return this;
};

net.Server.prototype.listen = function (...args) {
  report('listen', JSON.stringify(args[0] ?? null));
  throw new Error('net-guard: listening sockets are blocked');
};

for (const method of ['bind', 'send', 'connect']) {
  dgram.Socket.prototype[method] = function () {
    report(`udp-${method}`, '');
    throw new Error('net-guard: UDP is blocked');
  };
}

globalThis.fetch = async (url) => {
  report('fetch', String(url));
  throw new Error('net-guard: fetch is blocked');
};
