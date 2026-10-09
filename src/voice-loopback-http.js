"use strict";

// 仅连接 loopback 的 HTTP 客户端：显式直连（不走任何 proxy）、不跟随重定向。
const http = require("http");

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
// 显式 agent：Node http 本身不读 proxy 环境变量，这里再固定一个独立 agent 防止被全局 agent 替换。
const directAgent = new http.Agent({ keepAlive: false });

function err(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function parseLoopbackUrl(url, ports) {
  const u = new URL(url);
  if (u.protocol !== "http:" || !LOOPBACK_HOSTS.has(u.hostname)) {
    throw err("not_loopback", "only http loopback hosts are allowed");
  }
  const port = Number(u.port || 80);
  if (!Array.isArray(ports) || !ports.includes(port)) throw err("bad_port", "port not in whitelist");
  return { hostname: u.hostname.replace(/^\[|\]$/g, ""), port, path: u.pathname + u.search };
}

// 返回 Promise<{statusCode, headers, stream}>；stream 是 IncomingMessage。
function loopbackRequest({ url, ports, method = "GET", headers = {}, body, signal, timeoutMs = 0 }) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = parseLoopbackUrl(url, ports); } catch (e) { reject(e); return; }
    let settled = false;
    let timer = null;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      req.destroy();
      reject(e);
    };
    const req = http.request({ ...target, method, headers, agent: directAgent }, (res) => {
      if (settled) { res.destroy(); return; }
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        fail(err("redirect_blocked", "redirects are not followed"));
        return;
      }
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ statusCode: res.statusCode, headers: res.headers, stream: res });
    });
    // 响应开始后 abort 仍要销毁底层连接（流式读取中途取消）。
    function onAbort() { fail(err("aborted", "aborted")); req.destroy(); }
    req.on("error", (e) => fail(err("unreachable", e && e.code)));
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    if (timeoutMs > 0) timer = setTimeout(() => fail(err("timeout", "timeout")), timeoutMs);
    req.end(body);
  });
}

module.exports = { loopbackRequest, parseLoopbackUrl };
