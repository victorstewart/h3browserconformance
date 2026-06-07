import { spawn } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

export function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function webdriverCommandTimeoutMs() {
  const timeoutMs = Number(process.env.PICOQUIC_WT_WEBDRIVER_COMMAND_TIMEOUT_MS || 60000);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60000;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = webdriverCommandTimeoutMs()) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error(`fetch timeout after ${timeoutMs} ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function parseIntegerArrayEnv(name, fallback) {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((entry) =>
    Number.isInteger(entry) && entry >= 0 && entry <= 255)) {
    throw new Error(`${name} must be a JSON array of baton byte values`);
  }
  return parsed;
}

export function parseIntegerArrayVariantsEnv(name, fallback) {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.length === 0 ||
    !parsed.every((entry) => Array.isArray(entry) &&
      entry.every((value) => Number.isInteger(value) &&
        value >= 0 && value <= 255))) {
    throw new Error(`${name} must be a JSON array of baton byte arrays`);
  }
  return parsed;
}

export function parseNonNegativeIntegerArrayEnv(name, fallback) {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((entry) =>
    Number.isInteger(entry) && entry >= 0)) {
    throw new Error(`${name} must be a JSON array of non-negative integers`);
  }
  return parsed;
}

export function parseOptionalIntegerEnv(name) {
  const value = process.env[name];
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

export function parseOptionalPortEnv(name) {
  const value = process.env[name];
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`${name} must be a TCP port number`);
  }
  return parsed;
}

export function terminateProcess(child, signal = "SIGTERM", timeoutMs = 3000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolveTerminate) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolveTerminate();
      }
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch (_) {}
      done();
    }, timeoutMs);
    child.once("exit", done);
    try {
      child.kill(signal);
    } catch (_) {
      done();
    }
  });
}

export async function removeTree(path) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!["ENOTEMPTY", "EBUSY", "EPERM"].includes(error.code) || attempt === 4) {
        throw error;
      }
      await sleep(100 * (attempt + 1));
    }
  }
}

export function findOnPath(name) {
  if (name.includes("/") && existsSync(name)) {
    return name;
  }
  const path = process.env.PATH || "";
  for (const dir of path.split(":")) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return "";
}

export function assertFile(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} not found: ${path}`);
  }
}

export function runChecked(command, args) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  return new Promise((resolveRun, rejectRun) => {
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
      } else {
        rejectRun(new Error(`${command} failed: code=${code} signal=${signal} ${stderr.trim()}`));
      }
    });
  });
}

export async function getCertificateConfig(root, workDir) {
  const envCert = process.env.PICOQUIC_WT_CERT;
  const envKey = process.env.PICOQUIC_WT_KEY;
  if (envCert || envKey) {
    const cert = envCert || join(root, "certs", "cert.pem");
    const key = envKey || join(root, "certs", "key.pem");
    assertFile(cert, "certificate");
    assertFile(key, "private key");
    return {
      cert,
      key,
      hash: process.env.PICOQUIC_WT_CERT_HASH || certHash(cert)
    };
  }

  const certDir = join(workDir, "cert");
  const key = join(certDir, "key.pem");
  const cert = join(certDir, "cert.pem");
  rmSync(certDir, { recursive: true, force: true });
  mkdirSync(certDir, { recursive: true });
  await runChecked("openssl", [
    "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", key
  ]);
  await runChecked("openssl", [
    "req", "-new", "-x509",
    "-key", key,
    "-out", cert,
    "-days", "13",
    "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-addext", "keyUsage=digitalSignature",
    "-addext", "extendedKeyUsage=serverAuth"
  ]);

  return { cert, key, hash: process.env.PICOQUIC_WT_CERT_HASH || certHash(cert) };
}

export function certHash(certPath) {
  const cert = new X509Certificate(readFileSync(certPath));
  return createHash("sha256").update(cert.raw).digest("base64url");
}

export function equalArray(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length &&
    !actual.some((value, index) => value !== expected[index]);
}

export function equalExpectedBatonArray(actual, expected, orderMatters) {
  if (!Array.isArray(actual)) {
    return false;
  }
  if (orderMatters) {
    return equalArray(actual, expected);
  }
  return equalArray([...actual].sort((a, b) => a - b),
    [...expected].sort((a, b) => a - b));
}

export function equalExpectedBatonArrayVariant(actual, variants, orderMatters) {
  return Array.isArray(variants) &&
    variants.some((expected) => equalExpectedBatonArray(actual, expected, orderMatters));
}

export function buildBatonPageUrl(pageUrl, options) {
  const url = new URL(pageUrl);
  url.searchParams.set("autorun", "1");
  url.searchParams.set("timeoutMs", String(options.timeoutMs));
  url.searchParams.set("url", options.wtUrl);
  url.searchParams.set("protocol", options.protocol);
  if (!options.requireProtocol) {
    url.searchParams.set("requireProtocol", "0");
  }
  url.searchParams.set("certHash", options.certificateHash);
  url.searchParams.set("certHashAlg", options.certificateHashAlgorithm);
  if (!options.requireDatagram) {
    url.searchParams.set("requireDatagram", "0");
  }
  if (!options.useByob) {
    url.searchParams.set("useByob", "0");
  }
  if (options.datagramReceiveMode !== "baton") {
    url.searchParams.set("datagramReceiveMode", options.datagramReceiveMode);
  }
  if (options.datagramReceiveMin !== null) {
    url.searchParams.set("datagramReceiveMin", String(options.datagramReceiveMin));
  }
  if (options.datagramSendMode !== "baton") {
    url.searchParams.set("datagramSendMode", options.datagramSendMode);
  }
  if (options.datagramSendSize !== null) {
    url.searchParams.set("datagramSendSize", String(options.datagramSendSize));
  }
  if (options.datagramSendCount !== null) {
    url.searchParams.set("datagramSendCount", String(options.datagramSendCount));
  }
  if (options.streamMode !== "baton") {
    url.searchParams.set("streamMode", options.streamMode);
    url.searchParams.set("streamSize", String(options.streamSize));
    url.searchParams.set("streamCount", String(options.streamCount));
  }
  return url.href;
}

function contentType(filePath) {
  switch (extname(filePath)) {
  case ".html":
    return "text/html; charset=utf-8";
  case ".js":
    return "text/javascript; charset=utf-8";
  case ".css":
    return "text/css; charset=utf-8";
  default:
    return "application/octet-stream";
  }
}

export function startHarnessServer(webRoot, port) {
  const root = resolve(webRoot);
  const server = createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      let pathname = decodeURIComponent(requestUrl.pathname);
      if (pathname === "/") {
        pathname = "/index.html";
      }
      const filePath = resolve(root, `.${pathname}`);
      if (filePath !== root && !filePath.startsWith(root + sep)) {
        response.writeHead(403);
        response.end("forbidden");
        return;
      }
      if (!existsSync(filePath)) {
        response.writeHead(404);
        response.end("not found");
        return;
      }
      response.writeHead(200, {
        "content-type": contentType(filePath),
        "cache-control": "no-store"
      });
      response.end(readFileSync(filePath));
    } catch (error) {
      response.writeHead(500);
      response.end(error && error.message ? error.message : String(error));
    }
  });

  return new Promise((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", rejectServer);
      resolveServer({
        close() {
          server.close();
        },
        url: `http://127.0.0.1:${port}/index.html`
      });
    });
  });
}

export function waitForBatonServer(child) {
  return new Promise((resolveReady, rejectReady) => {
    let settled = false;
    const startupTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        clearTimeout(failTimer);
        resolveReady();
      }
    }, 750);
    const failTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        clearTimeout(startupTimer);
        rejectReady(new Error("pico_baton did not report readiness"));
      }
    }, 5000);

    function onData(data) {
      if (!settled && data.toString().includes("Waiting for packets")) {
        settled = true;
        clearTimeout(startupTimer);
        clearTimeout(failTimer);
        resolveReady();
      }
    }

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(startupTimer);
        clearTimeout(failTimer);
        rejectReady(new Error(`pico_baton exited before readiness: code=${code} signal=${signal}`));
      }
    });
  });
}

export async function waitForWebDriver(endpoint, childOutput, driverName, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetchWithTimeout(`${endpoint}/status`, {}, 1000);
      if (response.ok) {
        return;
      }
    } catch (_) {}
    await sleep(100);
  }
  throw new Error(`${driverName} did not become ready: ${childOutput()}`);
}

export async function webdriver(endpoint, method, path, body) {
  const response = await fetchWithTimeout(`${endpoint}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (_) {
    parsed = text;
  }

  if (!response.ok) {
    const value = parsed && parsed.value ? parsed.value : parsed;
    const message = value && value.message ? value.message : JSON.stringify(value);
    throw new Error(`WebDriver ${method} ${path} failed: HTTP ${response.status}: ${message}`);
  }
  return parsed ? parsed.value : null;
}

export function executeScript(endpoint, sessionId, script, args = []) {
  return webdriver(endpoint, "POST", `/session/${sessionId}/execute/sync`, {
    script,
    args
  });
}

export function executeAsyncScript(endpoint, sessionId, script, args = []) {
  return webdriver(endpoint, "POST", `/session/${sessionId}/execute/async`, {
    script,
    args
  });
}

export async function waitForWebDriverHarness(endpoint, sessionId) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const isReady = await executeScript(endpoint, sessionId,
      "return Boolean(window.__picoquicWebTransportResult);");
    if (isReady) {
      return;
    }
    await sleep(100);
  }
  const diagnostic = await executeScript(endpoint, sessionId,
    "return { href: location.href, readyState: document.readyState, " +
    "title: document.title, body: document.body ? document.body.innerText.slice(0, 500) : '' };");
  throw new Error(`browser harness did not start: ${JSON.stringify(diagnostic)}`);
}

export async function readWebDriverHarnessResult(endpoint, sessionId, timeoutMs) {
  const wrapped = await executeAsyncScript(endpoint, sessionId, `
    const done = arguments[arguments.length - 1];
    function errorText(error) {
      if (error && typeof error === "object") {
        return (error.name ? error.name + ": " : "") + (error.message || String(error));
      }
      return String(error);
    }
    Promise.race([
      window.__picoquicWebTransportResult,
      new Promise((_, reject) => setTimeout(() =>
        reject(new Error("timeout after ${timeoutMs} ms")), ${timeoutMs}))
    ]).then(
      (value) => done({ ok: true, value }),
      (error) => done({ ok: false, error: errorText(error) })
    );
  `);

  if (!wrapped || wrapped.ok !== true) {
    throw new Error((wrapped && wrapped.error) || "browser harness failed");
  }
  return wrapped.value;
}

export async function readWebDriverDiagnostic(
  endpoint, sessionId, functionName, options, extraOptions = {}) {
  const wrapped = await executeAsyncScript(endpoint, sessionId, `
    const done = arguments[arguments.length - 1];
    const functionName = arguments[0];
    const options = arguments[1];
    function errorText(error) {
      if (error && typeof error === "object") {
        return (error.name ? error.name + ": " : "") + (error.message || String(error));
      }
      return String(error);
    }
    Promise.resolve(
      window.picoquicWebTransportBaton[functionName](options)
    ).then(
      (value) => done({ ok: true, value }),
      (error) => done({ ok: false, error: errorText(error) })
    );
  `, [functionName, { ...options, ...extraOptions }]);

  if (!wrapped || wrapped.ok !== true) {
    throw new Error((wrapped && wrapped.error) ||
      `browser ${functionName} diagnostic failed`);
  }
  return wrapped.value;
}

export function assertBatonHarnessResult(result, options) {
  if (!options.expectOk) {
    if (!result || result.ok !== false || !result.error) {
      throw new Error(`browser harness unexpectedly succeeded: ${JSON.stringify(result)}`);
    }
    return;
  }
  if (!result || result.ok !== true) {
    throw new Error(`browser harness failed: ${JSON.stringify(result)}`);
  }
  if (options.requireProtocol && result.protocol !== options.protocol) {
    throw new Error(`unexpected protocol: ${result.protocol}`);
  }
  if (result.requireDatagram !== options.requireDatagram ||
    result.constructorRequireUnreliable !== options.requireDatagram) {
    throw new Error(`unexpected datagram requirement mode: ${JSON.stringify({
      requireDatagram: result.requireDatagram,
      constructorRequireUnreliable: result.constructorRequireUnreliable,
      expected: options.requireDatagram
    })}`);
  }
  if (result.useByob !== options.useByob) {
    throw new Error(`unexpected stream reader mode: ${JSON.stringify({
      useByob: result.useByob,
      expected: options.useByob
    })}`);
  }
  if ((result.streamMode || "baton") !== options.streamMode) {
    throw new Error(`unexpected stream mode: ${JSON.stringify({
      streamMode: result.streamMode,
      expected: options.streamMode
    })}`);
  }
  if (options.streamMode !== "baton") {
    if (result.streamSize !== options.streamSize ||
      result.streamCount !== options.streamCount) {
      throw new Error(`unexpected stream parameters: ${JSON.stringify({
        streamSize: result.streamSize,
        streamCount: result.streamCount,
        expectedSize: options.streamSize,
        expectedCount: options.streamCount
      })}`);
    }
    return;
  }
  if (result.datagramReceiveMode !== options.datagramReceiveMode) {
    throw new Error(`unexpected datagram receive mode: ${JSON.stringify({
      datagramReceiveMode: result.datagramReceiveMode,
      expected: options.datagramReceiveMode
    })}`);
  }
  if ((result.datagramSendMode || "baton") !== options.datagramSendMode) {
    throw new Error(`unexpected datagram send mode: ${JSON.stringify({
      datagramSendMode: result.datagramSendMode,
      expected: options.datagramSendMode
    })}`);
  }
  if (!equalExpectedBatonArray(result.received,
    options.expectedReceived, options.expectOrdered)) {
    throw new Error(`unexpected received baton sequence: ${JSON.stringify(result.received)}`);
  }
  if (options.expectedSentVariants ?
    !equalExpectedBatonArrayVariant(result.sent,
      options.expectedSentVariants, options.expectOrdered) :
    !equalExpectedBatonArray(result.sent,
      options.expectedSent, options.expectOrdered)) {
    throw new Error(`unexpected sent baton sequence: ${JSON.stringify(result.sent)}`);
  }
  if (options.expectedDatagramsReceived &&
    !equalArray(result.datagramsReceived, options.expectedDatagramsReceived)) {
    throw new Error(`unexpected received datagram sequence: ${JSON.stringify(result.datagramsReceived)}`);
  }
  if (options.expectedDatagramLengths &&
    !equalArray(result.datagramLengths, options.expectedDatagramLengths)) {
    throw new Error(`unexpected datagram lengths: ${JSON.stringify(result.datagramLengths)}`);
  }
  if (options.expectedDatagramsSent !== null &&
    result.datagramsSent !== options.expectedDatagramsSent) {
    throw new Error(`unexpected datagram sent count: ${JSON.stringify(result.datagramsSent)}`);
  }
  if (options.requireDatagram &&
    (!Array.isArray(result.datagramsReceived) || result.datagramsReceived.length === 0) &&
    (!Array.isArray(result.datagramLengths) || result.datagramLengths.length === 0)) {
    throw new Error("no WebTransport datagram received");
  }
}

export function assertDiagnosticResult(name, result) {
  if (!result || result.ok !== true) {
    throw new Error(`browser ${name} diagnostic failed: ${JSON.stringify(result)}`);
  }
}

export function summarizeCapabilities(capabilities, extraFields = {}) {
  if (!capabilities || typeof capabilities !== "object") {
    return {};
  }
  const summary = {
    browserName: capabilities.browserName || "",
    browserVersion: capabilities.browserVersion || "",
    platformName: capabilities.platformName || ""
  };
  for (const [name, value] of Object.entries(extraFields)) {
    summary[name] = typeof value === "function" ? value(capabilities) : value;
  }
  return summary;
}

export function countMatches(text, pattern) {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

export function sumMatches(text, pattern) {
  let sum = 0;
  for (const match of text.matchAll(pattern)) {
    sum += Number(match[1]);
  }
  return sum;
}

export function serverOutputHasBrowserClose(output) {
  return /error: 2a \(browser-close-test\)/.test(output);
}

export function serverOutputHasWritableBadChunkClose(output) {
  return /error: 0 \(writable-bad-chunk-test\)/.test(output);
}

export async function waitForServerOutput(predicate, getOutput, timeoutMs) {
  const boundedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0;
  const deadline = Date.now() + boundedTimeoutMs;

  while (!predicate(getOutput())) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    await sleep(Math.min(25, remaining));
  }
}

export function summarizeServerOutput(output) {
  return {
    bytesCaptured: output.length,
    waitingForPackets: output.includes("Waiting for packets"),
    connectAccepted: countMatches(output, /Connect accepted on stream/g),
    optionalProtocolAccepted: countMatches(output,
      /Accepting optional-protocol WebTransport CONNECT/g),
    packetsReceived: countMatches(output, /Receiving packet type/g),
    packetsSent: countMatches(output, /Sending packet type/g),
    h3ControlFrames: countMatches(output, /H3 control frame/g),
    originMissing: countMatches(output, /Missing WebTransport CONNECT origin/g),
    originRejected: countMatches(output, /WebTransport CONNECT origin rejected/g),
    batonParameterRejected: countMatches(output,
      /Rejecting malformed baton WebTransport CONNECT parameters/g),
    closeSessionReceived: countMatches(output,
      /Received web transport session capsule, type: 0x[0-9a-f]+ \(close session\)/g),
    closeSessionReceivedError42: countMatches(output,
      /Received web transport session capsule, type: 0x[0-9a-f]+ \(close session\), error: 2a /g),
    closeSessionSent: countMatches(output,
      /Sent WebTransport close session on stream/g),
    closeSessionSentError42: countMatches(output,
      /Sent WebTransport close session on stream: [0-9]+, error: 42/g),
    drainSessionSent: countMatches(output,
      /Sent WebTransport drain session on stream/g),
    controlFinNoCapsuleSent: countMatches(output,
      /Sent WebTransport control FIN without close capsule on stream/g),
    lifecycleTriggerReceived: countMatches(output,
      /Received WebTransport lifecycle trigger on stream/g),
    emptyDatagramsReceived: countMatches(output,
      /Received empty WebTransport datagram on stream/g),
    batonDatagramsReceived: countMatches(output,
      /Received baton WebTransport datagram on stream/g),
    sizedDatagramsReceived: countMatches(output,
      /Received sized WebTransport datagram on stream/g),
    datagramBytesReceived: sumMatches(output,
      /Received (?:baton|sized) WebTransport datagram on stream: [0-9]+, length: ([0-9]+)/g),
    zeroBatonReceived: countMatches(output, /All ZERO baton on stream/g),
    streamTestFinReceived: countMatches(output,
      /WebTransport stream test received FIN on stream/g),
    streamTestFinSent: countMatches(output,
      /WebTransport stream test sent FIN on stream/g),
    streamTestBytesReceived: sumMatches(output,
      /WebTransport stream test received FIN on stream: [0-9]+, bytes: ([0-9]+)/g),
    streamTestBytesSent: sumMatches(output,
      /WebTransport stream test sent FIN on stream: [0-9]+, bytes: ([0-9]+)/g),
    resetStreamReceived: countMatches(output,
      /Received WebTransport RESET_STREAM on stream/g),
    stopSendingReceived: countMatches(output,
      /Received WebTransport STOP_SENDING on stream/g),
    resetStreamSent: countMatches(output,
      /Sent WebTransport RESET_STREAM on stream/g),
    stopSendingSent: countMatches(output,
      /Sent WebTransport STOP_SENDING on stream/g),
    resetStreamAppError123: countMatches(output,
      /Received WebTransport RESET_STREAM on stream: [0-9]+, h3_error: [0-9]+, app_error: 123/g),
    stopSendingAppError123: countMatches(output,
      /Received WebTransport STOP_SENDING on stream: [0-9]+, h3_error: [0-9]+, app_error: 123/g),
    resetStreamSentAppError123: countMatches(output,
      /Sent WebTransport RESET_STREAM on stream: [0-9]+, h3_error: [0-9]+, app_error: 123/g),
    stopSendingSentAppError123: countMatches(output,
      /Sent WebTransport STOP_SENDING on stream: [0-9]+, h3_error: [0-9]+, app_error: 123/g),
    writableBadChunkCloseReceived:
      output.includes("error: 0 (writable-bad-chunk-test)"),
    browserCloseReceived: serverOutputHasBrowserClose(output)
  };
}

export function expectedStreamServerSummary(streamMode, streamSize, streamCount) {
  const bytes = streamSize * streamCount;
  if (streamMode === "client-bidi-echo" || streamMode === "client-uni-reply") {
    return {
      bytesReceived: bytes,
      bytesSent: bytes,
      finReceived: streamCount,
      finSent: streamCount
    };
  }
  if (streamMode === "server-uni") {
    return {
      bytesReceived: 0,
      bytesSent: bytes,
      finReceived: 0,
      finSent: streamCount
    };
  }
  if (streamMode === "server-bidi") {
    return {
      bytesReceived: 0,
      bytesSent: bytes,
      finReceived: streamCount,
      finSent: streamCount
    };
  }
  return null;
}

export function expectedResetServerSummary(streamMode) {
  if (streamMode === "browser-abort-bidi" || streamMode === "browser-abort-uni") {
    return {
      resetStreamReceived: 1,
      resetStreamAppError123: 1,
      stopSendingReceived: 0,
      stopSendingAppError123: 0,
      resetStreamSent: 0,
      resetStreamSentAppError123: 0,
      stopSendingSent: 0,
      stopSendingSentAppError123: 0
    };
  }
  if (streamMode === "browser-cancel-incoming-bidi" ||
    streamMode === "browser-cancel-incoming-uni") {
    return {
      resetStreamReceived: 0,
      resetStreamAppError123: 0,
      stopSendingReceived: 1,
      stopSendingAppError123: 1,
      resetStreamSent: 0,
      resetStreamSentAppError123: 0,
      stopSendingSent: 0,
      stopSendingSentAppError123: 0
    };
  }
  if (streamMode === "server-reset-bidi" || streamMode === "server-reset-uni") {
    return {
      resetStreamReceived: 0,
      resetStreamAppError123: 0,
      stopSendingReceived: 0,
      stopSendingAppError123: 0,
      resetStreamSent: 1,
      resetStreamSentAppError123: 1,
      stopSendingSent: 0,
      stopSendingSentAppError123: 0
    };
  }
  if (streamMode === "server-stop-bidi" || streamMode === "server-stop-uni") {
    return {
      resetStreamReceived: 0,
      resetStreamAppError123: 0,
      stopSendingReceived: 0,
      stopSendingAppError123: 0,
      resetStreamSent: 0,
      resetStreamSentAppError123: 0,
      stopSendingSent: 1,
      stopSendingSentAppError123: 1
    };
  }
  return null;
}

export function serverOutputHasResetSummary(output, streamMode) {
  const expected = expectedResetServerSummary(streamMode);
  if (!expected) {
    return true;
  }
  const summary = summarizeServerOutput(output);
  for (const [name, value] of Object.entries(expected)) {
    if (summary[name] < value) {
      return false;
    }
  }
  return true;
}

export function serverOutputHasStreamTestSummary(output, streamMode, streamSize, streamCount) {
  const expected = expectedStreamServerSummary(streamMode, streamSize, streamCount);
  if (!expected) {
    return true;
  }
  const summary = summarizeServerOutput(output);
  return summary.streamTestBytesReceived >= expected.bytesReceived &&
    summary.streamTestBytesSent >= expected.bytesSent &&
    summary.streamTestFinReceived >= expected.finReceived &&
    summary.streamTestFinSent >= expected.finSent;
}

export function mergeStreamTestSummary(summary, streamSummary) {
  if (!streamSummary) {
    return summary;
  }
  for (const name of ["streamTestBytesReceived", "streamTestBytesSent",
    "streamTestFinReceived", "streamTestFinSent"]) {
    summary[name] = streamSummary[name] || 0;
  }
  return summary;
}

export function isServerSummaryLine(line) {
  return line.includes("Waiting for packets") ||
    line.includes("Connect accepted on stream") ||
    line.includes("Accepting optional-protocol WebTransport CONNECT") ||
    line.includes("H3 control frame") ||
    line.includes("Missing WebTransport CONNECT origin") ||
    line.includes("WebTransport CONNECT origin rejected") ||
    line.includes("Rejecting malformed baton WebTransport CONNECT parameters") ||
    line.includes("Received web transport session capsule") ||
    line.includes("Sent WebTransport close session on stream") ||
    line.includes("Sent WebTransport drain session on stream") ||
    line.includes("Sent WebTransport control FIN without close capsule") ||
    line.includes("Received WebTransport lifecycle trigger on stream") ||
    line.includes("Received empty WebTransport datagram on stream") ||
    line.includes("Received baton WebTransport datagram on stream") ||
    line.includes("Received sized WebTransport datagram on stream") ||
    line.includes("All ZERO baton on stream") ||
    line.includes("WebTransport stream test ") ||
    line.includes("Received WebTransport RESET_STREAM") ||
    line.includes("Received WebTransport STOP_SENDING") ||
    line.includes("Sent WebTransport RESET_STREAM") ||
    line.includes("Sent WebTransport STOP_SENDING") ||
    line.includes("error: 0 (writable-bad-chunk-test)") ||
    line.includes("error: 2a (browser-close-test)");
}

export function makeServerOutputRecorder(options) {
  let output = "";
  let summaryTrace = "";
  let streamTrace = "";
  let lineBuffer = "";
  let packetReceivedCaptured = false;
  let packetSentCaptured = false;

  return {
    append(data) {
      const text = data.toString();
      output = (output + text).slice(-options.outputLimit);

      lineBuffer += text;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() || "";
      for (const line of lines) {
        let keepSummaryLine = isServerSummaryLine(line);
        if (!keepSummaryLine && line.includes("Receiving packet type")) {
          keepSummaryLine = !packetReceivedCaptured;
          packetReceivedCaptured = true;
        }
        if (!keepSummaryLine && line.includes("Sending packet type")) {
          keepSummaryLine = !packetSentCaptured;
          packetSentCaptured = true;
        }
        if (keepSummaryLine) {
          summaryTrace = (summaryTrace + line + "\n").slice(-options.summaryTraceLimit);
        }
        if (line.includes("WebTransport stream test ")) {
          streamTrace = (streamTrace + line + "\n").slice(-options.streamTraceLimit);
        }
      }
    },
    output() {
      return output;
    },
    summaryTrace() {
      const pending = isServerSummaryLine(lineBuffer) ||
        lineBuffer.includes("Receiving packet type") ||
        lineBuffer.includes("Sending packet type") ? `${lineBuffer}\n` : "";
      return summaryTrace + pending;
    },
    streamTrace() {
      const pending = lineBuffer.includes("WebTransport stream test ") ?
        `${lineBuffer}\n` : "";
      return streamTrace + pending;
    }
  };
}
