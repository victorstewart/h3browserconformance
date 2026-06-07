#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  parseIntegerArrayVariantsEnv,
  parseNonNegativeIntegerArrayEnv,
  parseOptionalIntegerEnv,
  parseOptionalPortEnv,
  readWebDriverDiagnostic,
  readWebDriverHarnessResult,
  removeTree,
  serverOutputHasBrowserClose,
  serverOutputHasResetSummary,
  serverOutputHasStreamTestSummary,
  serverOutputHasWritableBadChunkClose,
  sleep,
  startHarnessServer,
  summarizeCapabilities,
  summarizeServerOutput,
  terminateProcess,
  waitForBatonServer,
  waitForServerOutput,
  waitForWebDriver,
  waitForWebDriverHarness,
  webdriver
} from "./runner-common.mjs";

const SUITE_ROOT = resolve(new URL("..", import.meta.url).pathname);
const PICOQUIC_ROOT = resolve(process.env.PICOQUIC_REPO_ROOT || process.env.PICOQUIC_ROOT || process.cwd());
const BATON = process.env.PICO_BATON_BIN || join(PICOQUIC_ROOT, "build", "pico_baton");
const WEB_ROOT = process.env.PICOQUIC_WT_WEB_ROOT ||
  join(SUITE_ROOT, "browser");
const PORT = Number(process.env.PICOQUIC_WT_PORT || 4433);
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
const EXPECT_SENT_VARIANTS =
  parseIntegerArrayVariantsEnv("PICOQUIC_WT_EXPECT_SENT_VARIANTS", null);
const EXPECT_DATAGRAMS_RECEIVED =
  parseIntegerArrayEnv("PICOQUIC_WT_EXPECT_DATAGRAMS_RECEIVED", null);
const EXPECT_DATAGRAM_LENGTHS =
  parseNonNegativeIntegerArrayEnv("PICOQUIC_WT_EXPECT_DATAGRAM_LENGTHS", null);
const EXPECT_DATAGRAMS_SENT = parseOptionalIntegerEnv("PICOQUIC_WT_EXPECT_DATAGRAMS_SENT");
const EXPECT_ORDERED = process.env.PICOQUIC_WT_EXPECT_ORDERED !== "0";
/* W3C WebTransport requires allowPooling+serverCertificateHashes to throw.
 * Keep this diagnostic non-gating until each browser/version lane has known
 * behavior, then opt in with PICOQUIC_WT_OPTIONS_CONSTRUCTOR_REQUIRED=1.
 */
const REQUIRE_OPTIONS_CONSTRUCTOR = process.env.PICOQUIC_WT_OPTIONS_CONSTRUCTOR_REQUIRED === "1";
const INCLUDE_SERVER_SUMMARY = process.env.PICOQUIC_WT_INCLUDE_SERVER_SUMMARY === "1";
const SERVER_OUTPUT_LIMIT = INCLUDE_SERVER_SUMMARY ? 262144 : 32768;
const SERVER_SUMMARY_TRACE_LIMIT = 131072;
const SERVER_STREAM_TRACE_LIMIT = 65536;
const SERVER_SUMMARY_WAIT_MS = Number(process.env.PICOQUIC_WT_SERVER_SUMMARY_WAIT_MS || 2000);
const TIMEOUT_MS = Number(process.env.PICOQUIC_WT_TIMEOUT_MS || 30000);
/* Safari 26.4 on macos-26 GitHub run 26897744754 stalled while polling
 * safaridriver /status on the fixed port immediately after a standalone Safari
 * smoke. Use a fresh ephemeral WebDriver port by default; keep the env override
 * for local debugging and CI bisects.
 */
const SAFARI_DRIVER_PORT =
  parseOptionalPortEnv("PICOQUIC_WT_SAFARI_DRIVER_PORT");
/* Safari 26.4 on the macos-26 GitHub image can take longer than 30s for
 * safaridriver's /status endpoint to become reachable after a previous Safari
 * smoke run; see WebTransportBrowser runs 26802796720 and 26899009323. This is
 * WebDriver startup hardening only, before any WebTransport traffic is
 * attempted.
 */
const SAFARI_DRIVER_READY_MS =
  Number(process.env.PICOQUIC_WT_SAFARI_DRIVER_READY_MS || 90000);
const HARNESS_PORT = Number(process.env.PICOQUIC_WT_HARNESS_PORT || 8080);
const WT_URL = process.env.PICOQUIC_WT_URL ||
  `https://localhost:${PORT}/baton?version=0&baton=251&count=1`;
const PAGE_URL = process.env.PICOQUIC_WT_PAGE_URL || "";

const safariDriverNames = [
  process.env.SAFARI_DRIVER_BIN,
  "safaridriver",
  "/usr/bin/safaridriver",
  "/System/Cryptexes/App/usr/bin/safaridriver"
].filter(Boolean);

function unusedTcpPort() {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createTcpServer();
    probe.unref();
    probe.once("error", rejectPort);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (!address || typeof address !== "object") {
          rejectPort(new Error("could not allocate an unused TCP port"));
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

function findSafariDriver() {
  for (const name of safariDriverNames) {
    const found = findOnPath(name);
    if (found) {
      return found;
    }
  }
  return "";
}

async function newSafariSession(endpoint) {
  try {
    const value = await webdriver(endpoint, "POST", "/session", {
      capabilities: {
        alwaysMatch: {
          browserName: "safari"
        }
      }
    });
    if (!value || !value.sessionId) {
      throw new Error(`Safari session response did not include sessionId: ${JSON.stringify(value)}`);
    }
    return value;
  } catch (error) {
    if (/Allow remote automation|remote automation/i.test(error.message)) {
      throw new Error(
        `${error.message}\nEnable Safari Settings > Developer > Allow Remote Automation, ` +
        "or run `sudo safaridriver --enable`, then rerun this command.");
    }
    throw error;
  }
}

async function newSafariSessionWithRetry(endpoint) {
  const attempts = Number(process.env.PICOQUIC_WT_SAFARI_SESSION_ATTEMPTS || 3);
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await newSafariSession(endpoint);
    } catch (error) {
      lastError = error;
      if (!/session timed out|RWIApplication|launching a compatible local Safari|fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|other side closed/i.test(error.message) ||
        attempt + 1 >= attempts) {
        break;
      }
      /* Safari 26.4 on the macos-26 GitHub image has timed out while launching
       * Safari before any WebTransport traffic; see run 26802093974. Run
       * 27098517885 also observed a transient fetch failure between a healthy
       * /status probe and POST /session. Retry session creation so WebDriver
       * startup noise does not mask the picoquic WebTransport smoke signal.
       */
      await sleep(1500 * (attempt + 1));
    }
  }
  throw lastError;
}


async function main() {
  assertFile(BATON, "pico_baton");

  const safariDriver = findSafariDriver();
  if (!safariDriver) {
    throw new Error("No safaridriver binary found. Set SAFARI_DRIVER_BIN to run this test.");
  }

  const workDir = mkdtempSync(join(tmpdir(), "picoquic-wt-safari-"));
  const certConfig = await getCertificateConfig(PICOQUIC_ROOT, workDir);
  const harness = PAGE_URL ? null : await startHarnessServer(WEB_ROOT, HARNESS_PORT);
  const targetUrl = buildBatonPageUrl(PAGE_URL || harness.url, {
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
  const server = spawn(BATON, serverArgs, { cwd: PICOQUIC_ROOT, stdio: ["ignore", "pipe", "pipe"] });
  const serverOutput = makeServerOutputRecorder({
    outputLimit: SERVER_OUTPUT_LIMIT,
    summaryTraceLimit: SERVER_SUMMARY_TRACE_LIMIT,
    streamTraceLimit: SERVER_STREAM_TRACE_LIMIT
  });
  server.stdout.on("data", (data) => serverOutput.append(data));
  server.stderr.on("data", (data) => serverOutput.append(data));

  const safariDriverPort = SAFARI_DRIVER_PORT || await unusedTcpPort();
  const driver = spawn(safariDriver, ["-p", String(safariDriverPort)], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  let driverOutput = "";
  function appendDriverOutput(data) {
    driverOutput = (driverOutput + data.toString()).slice(-8192);
  }
  driver.stdout.on("data", appendDriverOutput);
  driver.stderr.on("data", appendDriverOutput);

  const endpoint = `http://127.0.0.1:${safariDriverPort}`;
  let sessionId = "";
  let browserCapabilities = {};
  try {
    await waitForBatonServer(server);
    await waitForWebDriver(endpoint, () => driverOutput.trim(),
      "safaridriver", SAFARI_DRIVER_READY_MS);
    const session = await newSafariSessionWithRetry(endpoint);
    sessionId = session.sessionId;
    browserCapabilities = summarizeCapabilities(session.capabilities, {
      safariUseSimulator: (capabilities) =>
        capabilities.safari_useSimulator || capabilities["safari:useSimulator"] || false
    });
    await webdriver(endpoint, "POST", `/session/${sessionId}/timeouts`, {
      script: TIMEOUT_MS + 5000,
      pageLoad: TIMEOUT_MS + 5000
    });
    await webdriver(endpoint, "POST", `/session/${sessionId}/url`, {
      url: targetUrl
    });
    await waitForWebDriverHarness(endpoint, sessionId);
    const result = await readWebDriverHarnessResult(endpoint, sessionId, TIMEOUT_MS);
    result.browser = browserCapabilities;
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
      expectedSentVariants: EXPECT_SENT_VARIANTS,
      expectedDatagramsReceived: EXPECT_DATAGRAMS_RECEIVED,
      expectedDatagramLengths: EXPECT_DATAGRAM_LENGTHS,
      expectedDatagramsSent: EXPECT_DATAGRAMS_SENT,
      expectOrdered: EXPECT_ORDERED
    });
    if (RUN_PROTOCOL_CONSTRUCTOR && EXPECT_OK && STREAM_MODE === "baton") {
      const diagnosticOptions = {
        url: WT_URL,
        certificateHash: certConfig.hash,
        protocol: PROTOCOL
      };
      result.protocolConstructor = await readWebDriverDiagnostic(endpoint, sessionId,
        "runProtocolConstructorTests", diagnosticOptions);
      assertDiagnosticResult("protocolConstructor", result.protocolConstructor);
      result.urlConstructor = await readWebDriverDiagnostic(endpoint, sessionId,
        "runUrlConstructorTests", diagnosticOptions);
      assertDiagnosticResult("urlConstructor", result.urlConstructor);
      result.optionsConstructor = await readWebDriverDiagnostic(endpoint, sessionId,
        "runOptionsConstructorTests", diagnosticOptions);
      if (REQUIRE_OPTIONS_CONSTRUCTOR) {
        assertDiagnosticResult("optionsConstructor", result.optionsConstructor);
      }
      const writableBadChunk = await readWebDriverDiagnostic(endpoint, sessionId,
        "runWritableBadChunkTests", diagnosticOptions, {
          requireDatagram: REQUIRE_DATAGRAM
        });
      result.datagramWritable = writableBadChunk.datagramWritable;
      assertDiagnosticResult("datagramWritable", result.datagramWritable);
      result.streamWritable = writableBadChunk.streamWritable;
      assertDiagnosticResult("streamWritable", result.streamWritable);
      if (INCLUDE_SERVER_SUMMARY &&
        result.datagramWritable && result.datagramWritable.ok === true &&
        result.streamWritable && result.streamWritable.ok === true) {
        /* Same evidence wait as Chrome: the browser diagnostic can resolve
         * before Node has captured pico_baton's writable-bad-chunk close log.
         */
        await waitForServerOutput(serverOutputHasWritableBadChunkClose,
          () => serverOutput.summaryTrace(), SERVER_SUMMARY_WAIT_MS);
      }
      result.closeSession = await readWebDriverDiagnostic(endpoint, sessionId,
        "runCloseSessionTests", diagnosticOptions, {
          requireDatagram: REQUIRE_DATAGRAM
        });
      if (INCLUDE_SERVER_SUMMARY && result.closeSession &&
        result.closeSession.ok === true) {
        /* Safari 26.4 GitHub run 26839636631, job 79142889799 completed the
         * browser close diagnostic but summarized server output before Node had
         * received pico_baton's close-capsule log. Keep the server assertion,
         * but wait briefly for the expected trace line before summarizing.
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
    const driverText = driverOutput.trim();
    const context = `page url: ${targetUrl}\nwt url: ${WT_URL}`;
    const details = [
      error.message,
      `context:\n${context}`,
      Object.keys(browserCapabilities).length > 0 ?
        `browser capabilities:\n${JSON.stringify(browserCapabilities, null, 2)}` : "",
      output ? `server output:\n${output}` : "",
      driverText ? `safaridriver output:\n${driverText}` : ""
    ].filter(Boolean).join("\n");
    throw new Error(details);
  } finally {
    if (sessionId) {
      try {
        await webdriver(endpoint, "DELETE", `/session/${sessionId}`);
      } catch (_) {}
    }
    await terminateProcess(driver);
    await terminateProcess(server);
    if (harness) {
      harness.close();
    }
    await removeTree(workDir);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
