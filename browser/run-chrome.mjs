#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertBatonHarnessResult,
  assertDiagnosticResult,
  assertFile,
  buildBatonPageUrl,
  findOnPath,
  getCertificateConfig,
  makeServerOutputRecorder,
  mergeStreamTestSummary,
  parseIntegerArrayEnv,
  parseNonNegativeIntegerArrayEnv,
  parseOptionalIntegerEnv,
  removeTree,
  serverOutputHasBrowserClose,
  serverOutputHasResetSummary,
  serverOutputHasStreamTestSummary,
  serverOutputHasWritableBadChunkClose,
  sleep,
  summarizeServerOutput,
  terminateProcess,
  waitForBatonServer,
  waitForServerOutput
} from "./runner-common.mjs";

const SUITE_ROOT = resolve(new URL("..", import.meta.url).pathname);
const IMPLEMENTATION_ROOT = resolve(
  process.env.WT_CONFORMANCE_IMPLEMENTATION_ROOT ||
  process.env.PICOQUIC_REPO_ROOT ||
  process.env.PICOQUIC_ROOT ||
  process.cwd());
const BATON = process.env.WT_CONFORMANCE_SERVER_BIN ||
  process.env.PICO_BATON_BIN ||
  join(IMPLEMENTATION_ROOT, "build", "pico_baton");
const WEB_ROOT = process.env.WT_CONFORMANCE_WEB_ROOT ||
  process.env.PICOQUIC_WT_WEB_ROOT ||
  join(SUITE_ROOT, "browser");
const PORT = Number(process.env.WT_CONFORMANCE_PORT ||
  process.env.PICOQUIC_WT_PORT || 4433);
const PROTOCOL = process.env.PICOQUIC_WT_PROTOCOL || "devious-baton-00";
const REQUIRE_PROTOCOL = process.env.PICOQUIC_WT_REQUIRE_PROTOCOL !== "0";
const REQUIRE_DATAGRAM = process.env.PICOQUIC_WT_REQUIRE_DATAGRAM !== "0";
const USE_BYOB = process.env.PICOQUIC_WT_USE_BYOB !== "0";
const DATAGRAM_RECEIVE_MODE = process.env.PICOQUIC_WT_DATAGRAM_RECEIVE_MODE || "baton";
const DATAGRAM_RECEIVE_MIN = parseOptionalIntegerEnv("PICOQUIC_WT_DATAGRAM_RECEIVE_MIN");
const DATAGRAM_SEND_MODE = process.env.PICOQUIC_WT_DATAGRAM_SEND_MODE || "baton";
const DATAGRAM_SEND_SIZE = parseOptionalIntegerEnv("PICOQUIC_WT_DATAGRAM_SEND_SIZE");
const DATAGRAM_SEND_COUNT = parseOptionalIntegerEnv("PICOQUIC_WT_DATAGRAM_SEND_COUNT");
const STREAM_MODE = process.env.PICOQUIC_WT_STREAM_MODE || "baton";
const STREAM_SIZE = parseOptionalIntegerEnv("PICOQUIC_WT_STREAM_SIZE") || 0;
const STREAM_COUNT = parseOptionalIntegerEnv("PICOQUIC_WT_STREAM_COUNT") || 1;
const EXPECT_OK = process.env.PICOQUIC_WT_EXPECT_OK !== "0";
const RUN_PROTOCOL_CONSTRUCTOR = process.env.PICOQUIC_WT_PROTOCOL_CONSTRUCTOR !== "0";
const CERT_HASH_ALG = process.env.PICOQUIC_WT_CERT_HASH_ALG || "sha-256";
const EXPECT_RECEIVED = parseIntegerArrayEnv("PICOQUIC_WT_EXPECT_RECEIVED", [251, 253, 255]);
const EXPECT_SENT = parseIntegerArrayEnv("PICOQUIC_WT_EXPECT_SENT", [252, 254, 0]);
const EXPECT_DATAGRAMS_RECEIVED =
  parseIntegerArrayEnv("PICOQUIC_WT_EXPECT_DATAGRAMS_RECEIVED", null);
const EXPECT_DATAGRAM_LENGTHS =
  parseNonNegativeIntegerArrayEnv("PICOQUIC_WT_EXPECT_DATAGRAM_LENGTHS", null);
const EXPECT_DATAGRAMS_SENT = parseOptionalIntegerEnv("PICOQUIC_WT_EXPECT_DATAGRAMS_SENT");
const EXPECT_ORDERED = process.env.PICOQUIC_WT_EXPECT_ORDERED !== "0";
/* W3C WebTransport requires allowPooling+serverCertificateHashes to throw, but
 * Chrome 148.0.7778.181 constructed instead during local validation. Record the
 * diagnostic by default and let browser/version-specific lanes opt into gating.
 */
const REQUIRE_OPTIONS_CONSTRUCTOR = process.env.PICOQUIC_WT_OPTIONS_CONSTRUCTOR_REQUIRED === "1";
const INCLUDE_SERVER_SUMMARY = process.env.PICOQUIC_WT_INCLUDE_SERVER_SUMMARY === "1";
const SERVER_OUTPUT_LIMIT = INCLUDE_SERVER_SUMMARY ? 262144 : 32768;
const SERVER_SUMMARY_TRACE_LIMIT = 131072;
const SERVER_STREAM_TRACE_LIMIT = 65536;
const SERVER_SUMMARY_WAIT_MS = Number(process.env.PICOQUIC_WT_SERVER_SUMMARY_WAIT_MS || 2000);
const TIMEOUT_MS = Number(process.env.PICOQUIC_WT_TIMEOUT_MS || 30000);
const CDP_PORT = Number(process.env.PICOQUIC_WT_CDP_PORT || 9223);
const CDP_TIMEOUT_MS = Number(process.env.PICOQUIC_WT_CDP_TIMEOUT_MS || 30000);
/* Chrome 148 x64 under Rosetta on Apple Silicon was observed to stay alive but
 * never expose the DevTools endpoint with --headless=new. Keep the modern
 * default, but let local/CI runs select --headless=old when that startup
 * behavior is encountered.
 */
const CHROME_HEADLESS = process.env.PICOQUIC_WT_CHROME_HEADLESS || "new";
const CHROME_ARCH = process.env.PICOQUIC_WT_CHROME_ARCH || "";
const CHROME_ARCHES = new Set(["arm64", "x86_64"]);
const CHROME_IGNORE_CERT_ERRORS = process.env.PICOQUIC_WT_IGNORE_CERT_ERRORS !== "0";
const WT_URL = process.env.PICOQUIC_WT_URL ||
  `https://localhost:${PORT}/baton?version=0&baton=251&count=1`;
const PAGE_URL = process.env.PICOQUIC_WT_PAGE_URL ||
  pathToFileURL(join(WEB_ROOT, "index.html")).href;

const chromeNames = [
  process.env.CHROME_BIN,
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "chrome"
].filter(Boolean);

function findChrome() {
  for (const name of chromeNames) {
    const found = findOnPath(name);
    if (found) {
      return found;
    }
  }
  return "";
}

async function waitForCdpEndpoint() {
  const endpoint = `http://127.0.0.1:${CDP_PORT}`;
  const deadline = Date.now() + CDP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) {
        return endpoint;
      }
    } catch (_) {}
    await sleep(100);
  }
  throw new Error("Chrome DevTools endpoint did not become ready");
}

async function readChromeBrowserInfo(endpoint) {
  const response = await fetch(`${endpoint}/json/version`);
  if (!response.ok) {
    throw new Error(`Chrome DevTools version query failed: HTTP ${response.status}`);
  }
  const version = await response.json();
  const product = version.Browser || "";
  const slash = product.indexOf("/");
  return {
    browserName: slash > 0 ? product.slice(0, slash) : (product || "Chrome"),
    browserVersion: slash >= 0 ? product.slice(slash + 1) : "",
    product,
    protocolVersion: version["Protocol-Version"] || "",
    userAgent: version["User-Agent"] || "",
    platformName: process.platform
  };
}

async function newTarget(endpoint) {
  const targetUrl = `${endpoint}/json/new?about%3Ablank`;
  let response = await fetch(targetUrl, { method: "PUT" });
  if (!response.ok) {
    response = await fetch(targetUrl);
  }
  if (!response.ok) {
    throw new Error(`cannot create Chrome target: HTTP ${response.status}`);
  }
  const target = await response.json();
  if (!target.webSocketDebuggerUrl) {
    throw new Error("Chrome target did not include a websocket URL");
  }
  return target.webSocketDebuggerUrl;
}

function connectCdp(url) {
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 1;

    socket.addEventListener("open", () => {
      resolveSocket({
        close() {
          socket.close();
        },
        send(method, params = {}) {
          const id = nextId++;
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise((resolveCommand, rejectCommand) => {
            pending.set(id, { resolveCommand, rejectCommand });
          });
        }
      });
    }, { once: true });

    socket.addEventListener("error", () => {
      rejectSocket(new Error("Chrome DevTools websocket failed"));
    }, { once: true });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) {
        return;
      }
      const pendingCommand = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        pendingCommand.rejectCommand(new Error(message.error.message));
      } else {
        pendingCommand.resolveCommand(message.result);
      }
    });
  });
}

async function waitForHarness(cdp) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const probe = await cdp.send("Runtime.evaluate", {
      expression: "Boolean(window.__h3BrowserConformanceResult)",
      returnByValue: true
    });
    if (probe.result && probe.result.value) {
      return;
    }
    await sleep(100);
  }
  const diagnostic = await cdp.send("Runtime.evaluate", {
    expression: "({ href: location.href, readyState: document.readyState, title: document.title, body: document.body ? document.body.innerText.slice(0, 500) : '' })",
    returnByValue: true
  });
  throw new Error(`browser harness did not start: ${JSON.stringify(diagnostic.result.value)}`);
}

async function readHarnessResult(cdp) {
  const expression =
    "Promise.race([" +
    "window.__h3BrowserConformanceResult," +
    `new Promise((_, reject) => setTimeout(() => reject(new Error('timeout after ${TIMEOUT_MS} ms')), ${TIMEOUT_MS}))` +
    "])";
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });

  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception &&
      result.exceptionDetails.exception.description;
    throw new Error(text || result.exceptionDetails.text || "browser harness failed");
  }
  return result.result.value;
}

async function readProtocolConstructorResult(cdp, certificateHash) {
  const options = JSON.stringify({
    url: WT_URL,
    certificateHash,
    protocol: PROTOCOL
  });
  const result = await cdp.send("Runtime.evaluate", {
    expression: `window.h3BrowserConformanceBaton.runProtocolConstructorTests(${options})`,
    awaitPromise: true,
    returnByValue: true
  });

  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception &&
      result.exceptionDetails.exception.description;
    throw new Error(text || result.exceptionDetails.text ||
      "browser protocol constructor tests failed");
  }
  return result.result.value;
}

async function readUrlConstructorResult(cdp, certificateHash) {
  const options = JSON.stringify({
    url: WT_URL,
    certificateHash,
    protocol: PROTOCOL
  });
  const result = await cdp.send("Runtime.evaluate", {
    expression: `window.h3BrowserConformanceBaton.runUrlConstructorTests(${options})`,
    awaitPromise: true,
    returnByValue: true
  });

  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception &&
      result.exceptionDetails.exception.description;
    throw new Error(text || result.exceptionDetails.text ||
      "browser URL constructor tests failed");
  }
  return result.result.value;
}

async function readOptionsConstructorResult(cdp, certificateHash) {
  const options = JSON.stringify({
    url: WT_URL,
    certificateHash,
    protocol: PROTOCOL
  });
  const result = await cdp.send("Runtime.evaluate", {
    expression: `window.h3BrowserConformanceBaton.runOptionsConstructorTests(${options})`,
    awaitPromise: true,
    returnByValue: true
  });

  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception &&
      result.exceptionDetails.exception.description;
    throw new Error(text || result.exceptionDetails.text ||
      "browser options constructor tests failed");
  }
  return result.result.value;
}

async function readWritableBadChunkResult(cdp, certificateHash) {
  const options = JSON.stringify({
    url: WT_URL,
    certificateHash,
    protocol: PROTOCOL,
    requireDatagram: REQUIRE_DATAGRAM
  });
  const result = await cdp.send("Runtime.evaluate", {
    expression: `window.h3BrowserConformanceBaton.runWritableBadChunkTests(${options})`,
    awaitPromise: true,
    returnByValue: true
  });

  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception &&
      result.exceptionDetails.exception.description;
    throw new Error(text || result.exceptionDetails.text ||
      "browser writable bad chunk tests failed");
  }
  return result.result.value;
}

async function readCloseSessionResult(cdp, certificateHash) {
  const options = JSON.stringify({
    url: WT_URL,
    certificateHash,
    protocol: PROTOCOL,
    requireDatagram: REQUIRE_DATAGRAM
  });
  const result = await cdp.send("Runtime.evaluate", {
    expression: `window.h3BrowserConformanceBaton.runCloseSessionTests(${options})`,
    awaitPromise: true,
    returnByValue: true
  });

  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception &&
      result.exceptionDetails.exception.description;
    throw new Error(text || result.exceptionDetails.text ||
      "browser close-session tests failed");
  }
  return result.result.value;
}

async function main() {
  assertFile(BATON, "pico_baton");

  const chrome = findChrome();
  if (!chrome) {
    throw new Error("No Chrome/Chromium binary found. Set CHROME_BIN to run this test.");
  }

  const profile = mkdtempSync(join(tmpdir(), "h3-wt-chrome-"));
  const certConfig = await getCertificateConfig(IMPLEMENTATION_ROOT, profile);
  const targetUrl = buildBatonPageUrl(PAGE_URL, {
    timeoutMs: TIMEOUT_MS,
    wtUrl: WT_URL,
    protocol: PROTOCOL,
    requireProtocol: REQUIRE_PROTOCOL,
    certificateHash: certConfig.hash,
    certificateHashAlgorithm: CERT_HASH_ALG,
    requireDatagram: REQUIRE_DATAGRAM,
    useByob: USE_BYOB,
    datagramReceiveMode: DATAGRAM_RECEIVE_MODE,
    datagramReceiveMin: DATAGRAM_RECEIVE_MIN,
    datagramSendMode: DATAGRAM_SEND_MODE,
    datagramSendSize: DATAGRAM_SEND_SIZE,
    datagramSendCount: DATAGRAM_SEND_COUNT,
    streamMode: STREAM_MODE,
    streamSize: STREAM_SIZE,
    streamCount: STREAM_COUNT
  });
  const serverArgs = [
    "-p", String(PORT),
    "-c", certConfig.cert,
    "-k", certConfig.key,
    "-w", WEB_ROOT,
    "/baton"
  ];
  if (process.env.PICOQUIC_WT_SERVER_LOG || INCLUDE_SERVER_SUMMARY) {
    const serverLog = process.env.PICOQUIC_WT_SERVER_LOG || "1";
    const logTarget = serverLog === "1" ? "-" : serverLog;
    serverArgs.splice(serverArgs.length - 1, 0, "-l", logTarget, "-L");
  }
  const server = spawn(BATON, serverArgs, {
    cwd: IMPLEMENTATION_ROOT,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const serverOutput = makeServerOutputRecorder({
    outputLimit: SERVER_OUTPUT_LIMIT,
    summaryTraceLimit: SERVER_SUMMARY_TRACE_LIMIT,
    streamTraceLimit: SERVER_STREAM_TRACE_LIMIT
  });
  server.stdout.on("data", (data) => serverOutput.append(data));
  server.stderr.on("data", (data) => serverOutput.append(data));

  let chromeProcess = null;
  let cdp = null;
  let browserInfo = {};
  try {
    await waitForBatonServer(server);

    const chromeArgs = [
      `--headless=${CHROME_HEADLESS}`,
      "--no-first-run",
      "--disable-background-networking",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--enable-quic",
      ...(CHROME_IGNORE_CERT_ERRORS ? ["--ignore-certificate-errors"] : []),
      `--origin-to-force-quic-on=localhost:${PORT}`,
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      "about:blank"
    ];
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      chromeArgs.splice(1, 0, "--no-sandbox");
    }
    if (process.env.PICOQUIC_WT_NETLOG) {
      chromeArgs.splice(chromeArgs.length - 1, 0,
        `--log-net-log=${process.env.PICOQUIC_WT_NETLOG}`,
        "--net-log-capture-mode=Everything");
    }
    if (CHROME_ARCH && !CHROME_ARCHES.has(CHROME_ARCH)) {
      throw new Error(`Unsupported PICOQUIC_WT_CHROME_ARCH=${JSON.stringify(CHROME_ARCH)}`);
    }
    const chromeCommand = CHROME_ARCH ? "/usr/bin/arch" : chrome;
    const chromeCommandArgs = CHROME_ARCH ? [`-${CHROME_ARCH}`, chrome, ...chromeArgs] : chromeArgs;
    chromeProcess = spawn(chromeCommand, chromeCommandArgs, { stdio: ["ignore", "ignore", "pipe"] });
    let chromeStderr = "";
    chromeProcess.stderr.on("data", (data) => {
      chromeStderr = (chromeStderr + data.toString()).slice(-4096);
    });

    let endpoint = "";
    try {
      endpoint = await waitForCdpEndpoint();
      browserInfo = await readChromeBrowserInfo(endpoint);
    } catch (error) {
      const stderr = chromeStderr.trim();
      throw new Error(stderr ? `${error.message}: ${stderr}` : error.message);
    }
    cdp = await connectCdp(await newTarget(endpoint));
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.navigate", { url: targetUrl });
    await waitForHarness(cdp);
    const result = await readHarnessResult(cdp);
    result.browser = browserInfo;
    let streamServerSummary = null;
    if (INCLUDE_SERVER_SUMMARY && STREAM_MODE !== "baton") {
      await waitForServerOutput((output) =>
        serverOutputHasStreamTestSummary(output, STREAM_MODE, STREAM_SIZE, STREAM_COUNT),
        () => serverOutput.streamTrace(), SERVER_SUMMARY_WAIT_MS);
      await waitForServerOutput((output) =>
        serverOutputHasResetSummary(output, STREAM_MODE),
        () => serverOutput.summaryTrace(), SERVER_SUMMARY_WAIT_MS);
      streamServerSummary = summarizeServerOutput(serverOutput.streamTrace());
    }
    if (INCLUDE_SERVER_SUMMARY) {
      result.server = mergeStreamTestSummary(summarizeServerOutput(serverOutput.summaryTrace()),
        streamServerSummary);
    }
    assertBatonHarnessResult(result, {
      expectOk: EXPECT_OK,
      requireProtocol: REQUIRE_PROTOCOL,
      protocol: PROTOCOL,
      requireDatagram: REQUIRE_DATAGRAM,
      useByob: USE_BYOB,
      streamMode: STREAM_MODE,
      streamSize: STREAM_SIZE,
      streamCount: STREAM_COUNT,
      datagramReceiveMode: DATAGRAM_RECEIVE_MODE,
      datagramSendMode: DATAGRAM_SEND_MODE,
      expectedReceived: EXPECT_RECEIVED,
      expectedSent: EXPECT_SENT,
      expectedSentVariants: null,
      expectedDatagramsReceived: EXPECT_DATAGRAMS_RECEIVED,
      expectedDatagramLengths: EXPECT_DATAGRAM_LENGTHS,
      expectedDatagramsSent: EXPECT_DATAGRAMS_SENT,
      expectOrdered: EXPECT_ORDERED
    });
    if (RUN_PROTOCOL_CONSTRUCTOR && EXPECT_OK && STREAM_MODE === "baton") {
      result.protocolConstructor = await readProtocolConstructorResult(cdp, certConfig.hash);
      assertDiagnosticResult("protocolConstructor", result.protocolConstructor);
      result.urlConstructor = await readUrlConstructorResult(cdp, certConfig.hash);
      assertDiagnosticResult("urlConstructor", result.urlConstructor);
      result.optionsConstructor = await readOptionsConstructorResult(cdp, certConfig.hash);
      if (REQUIRE_OPTIONS_CONSTRUCTOR) {
        assertDiagnosticResult("optionsConstructor", result.optionsConstructor);
      }
      const writableBadChunk = await readWritableBadChunkResult(cdp, certConfig.hash);
      result.datagramWritable = writableBadChunk.datagramWritable;
      assertDiagnosticResult("datagramWritable", result.datagramWritable);
      result.streamWritable = writableBadChunk.streamWritable;
      assertDiagnosticResult("streamWritable", result.streamWritable);
      if (INCLUDE_SERVER_SUMMARY &&
        result.datagramWritable && result.datagramWritable.ok === true &&
        result.streamWritable && result.streamWritable.ok === true) {
        /* Local C34i smoke on 2026-06-04 completed the browser writable
         * diagnostic before Node had captured pico_baton's close-capsule log.
         * Wait for the asserted server evidence before summarizing.
         */
        await waitForServerOutput(serverOutputHasWritableBadChunkClose,
          () => serverOutput.summaryTrace(), SERVER_SUMMARY_WAIT_MS);
      }
      result.closeSession = await readCloseSessionResult(cdp, certConfig.hash);
      if (INCLUDE_SERVER_SUMMARY && result.closeSession && result.closeSession.ok === true) {
        /* GitHub run 26838267520 showed Chrome job 79137977278 and Edge job
         * 79137977123 completing the browser close diagnostic before Node had
         * received pico_baton's close-capsule log. The Chrome rerun job
         * 79138790636 reproduced it. Keep the server assertion, but wait
         * briefly for the expected trace line before summarizing.
        */
        await waitForServerOutput(serverOutputHasBrowserClose,
          () => serverOutput.summaryTrace(), SERVER_SUMMARY_WAIT_MS);
      }
    }
    if (INCLUDE_SERVER_SUMMARY) {
      result.server = mergeStreamTestSummary(summarizeServerOutput(serverOutput.summaryTrace()),
        streamServerSummary);
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const output = [
      serverOutput.output().trim(),
      serverOutput.summaryTrace().trim() ?
        `server summary trace:\n${serverOutput.summaryTrace().trim()}` : "",
      serverOutput.streamTrace().trim() ?
        `server stream trace:\n${serverOutput.streamTrace().trim()}` : ""
    ].filter(Boolean).join("\n");
    if (output) {
      throw new Error(`${error.message}\nserver output:\n${output}`);
    }
    throw error;
  } finally {
    if (cdp) {
      cdp.close();
    }
    await terminateProcess(chromeProcess);
    await terminateProcess(server);
    await removeTree(profile);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
