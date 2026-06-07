#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
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
  parseNonNegativeIntegerArrayEnv,
  parseOptionalIntegerEnv,
  readWebDriverDiagnostic,
  readWebDriverHarnessResult,
  removeTree,
  serverOutputHasResetSummary,
  serverOutputHasStreamTestSummary,
  serverOutputHasWritableBadChunkClose,
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
/* Firefox 151.0.2 in GitHub Actions accepted invalid protocols constructor
 * inputs instead of throwing; see run 26801732536. Keep recording the
 * diagnostic, but let the Firefox expected-results manifest classify it as a
 * browser API gap while the lane exercises picoquic's data path.
 */
const REQUIRE_PROTOCOL_CONSTRUCTOR =
  process.env.PICOQUIC_WT_PROTOCOL_CONSTRUCTOR_REQUIRED !== "0";
const REQUIRE_OPTIONS_CONSTRUCTOR = process.env.PICOQUIC_WT_OPTIONS_CONSTRUCTOR_REQUIRED === "1";
/* Firefox 151.0.2 in GitHub Actions can reject the bidirectional writable
 * bad-chunk diagnostic setup with InvalidStateError after multiple sequential
 * WebTransport sessions; see run 26802934161. Keep recording the diagnostic,
 * but let the expected-results manifest classify the Firefox core E2E gap.
 */
const REQUIRE_STREAM_WRITABLE = process.env.PICOQUIC_WT_STREAM_WRITABLE_REQUIRED !== "0";
const INCLUDE_SERVER_SUMMARY = process.env.PICOQUIC_WT_INCLUDE_SERVER_SUMMARY === "1";
const SERVER_OUTPUT_LIMIT = INCLUDE_SERVER_SUMMARY ? 262144 : 32768;
const SERVER_SUMMARY_TRACE_LIMIT = 131072;
const SERVER_STREAM_TRACE_LIMIT = 65536;
const SERVER_SUMMARY_WAIT_MS = Number(process.env.PICOQUIC_WT_SERVER_SUMMARY_WAIT_MS || 2000);
const TIMEOUT_MS = Number(process.env.PICOQUIC_WT_TIMEOUT_MS || 30000);
const GECKO_DRIVER_PORT = Number(process.env.PICOQUIC_WT_GECKO_DRIVER_PORT || 9445);
const HARNESS_PORT = Number(process.env.PICOQUIC_WT_HARNESS_PORT || 8081);
const FIREFOX_HEADLESS = process.env.PICOQUIC_WT_FIREFOX_HEADLESS !== "0";
/* Firefox 151.0.2 in GitHub Actions did not provide a usable
 * WT-Available-Protocols value to pico_baton after CONNECT reached the server;
 * see run 26801289699. This opt-in keeps the Firefox lane on the data path
 * without claiming WT-Protocol selection for Firefox.
 */
const FIREFOX_PROTOCOL_OPTIONAL = process.env.PICOQUIC_WT_FIREFOX_PROTOCOL_OPTIONAL === "1";
/* Firefox 151.0.2 in GitHub Actions rejected the local self-signed
 * WebTransport endpoint before CONNECT when relying only on
 * serverCertificateHashes; see run 26801130235. Keep this WebDriver-only
 * certificate bypass opt-in isolated to Firefox lanes so the browser can still
 * exercise picoquic's WebTransport data path. The Firefox expected-results
 * manifest skips the wrong-hash scenario while this browser path is in use.
 */
const FIREFOX_ACCEPT_INSECURE_CERTS =
  process.env.PICOQUIC_WT_FIREFOX_ACCEPT_INSECURE_CERTS === "1";
const FIREFOX_BIN = process.env.FIREFOX_BIN || "";
const RAW_WT_URL = process.env.PICOQUIC_WT_URL ||
  `https://localhost:${PORT}/baton?version=0&baton=251&count=1`;
const WT_URL = firefoxWtUrl(RAW_WT_URL);
const REQUESTED_PROTOCOL = process.env.PICOQUIC_WT_PROTOCOL || "devious-baton-00";
const PROTOCOL = FIREFOX_PROTOCOL_OPTIONAL ? "" : REQUESTED_PROTOCOL;
const REQUIRE_PROTOCOL = process.env.PICOQUIC_WT_REQUIRE_PROTOCOL !== "0";
const PAGE_URL = process.env.PICOQUIC_WT_PAGE_URL || "";

const geckoDriverNames = [
  process.env.GECKO_DRIVER_BIN,
  process.env.GECKODRIVER_BIN,
  "geckodriver"
].filter(Boolean);

function findGeckoDriver() {
  for (const name of geckoDriverNames) {
    const found = findOnPath(name);
    if (found) {
      return found;
    }
  }
  return "";
}

function useFirefoxProtocolOptionalEndpoint() {
  /* Firefox 151.0.3 CI still needs the protocol=optional endpoint to exercise
   * stream-mode data paths. Keep strict negative/core rows unchanged when they
   * are expected to reject, but let expected stream-mode browser gaps still
   * reach pico_baton so server FIN/byte assertions remain meaningful.
   */
  return FIREFOX_PROTOCOL_OPTIONAL && (EXPECT_OK || STREAM_MODE !== "baton");
}

function firefoxWtUrl(rawUrl) {
  if (!useFirefoxProtocolOptionalEndpoint()) {
    return rawUrl;
  }
  const url = new URL(rawUrl);
  url.searchParams.set("protocol", "optional");
  return url.href;
}

async function newFirefoxSession(endpoint) {
  const firefoxOptions = {
    args: FIREFOX_HEADLESS ? ["-headless"] : []
  };
  if (FIREFOX_BIN) {
    assertFile(FIREFOX_BIN, "Firefox binary");
    firefoxOptions.binary = FIREFOX_BIN;
  }

  const value = await webdriver(endpoint, "POST", "/session", {
    capabilities: {
      alwaysMatch: {
        browserName: "firefox",
        acceptInsecureCerts: FIREFOX_ACCEPT_INSECURE_CERTS,
        "moz:firefoxOptions": firefoxOptions
      }
    }
  });
  if (!value || !value.sessionId) {
    throw new Error(`Firefox session response did not include sessionId: ${JSON.stringify(value)}`);
  }
  return value;
}


async function main() {
  assertFile(BATON, "pico_baton");

  const geckoDriver = findGeckoDriver();
  if (!geckoDriver) {
    throw new Error("No geckodriver binary found. Set GECKO_DRIVER_BIN to run this test.");
  }

  const workDir = mkdtempSync(join(tmpdir(), "picoquic-wt-firefox-"));
  const certConfig = await getCertificateConfig(PICOQUIC_ROOT, workDir);
  const harness = PAGE_URL ? null : await startHarnessServer(WEB_ROOT, HARNESS_PORT);
  const targetUrl = buildBatonPageUrl(PAGE_URL || harness.url, {
    timeoutMs: TIMEOUT_MS,
    wtUrl: WT_URL,
    protocol: REQUESTED_PROTOCOL,
    requireProtocol: REQUIRE_PROTOCOL && !useFirefoxProtocolOptionalEndpoint(),
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

  const driverEnv = {
    ...process.env,
    MOZ_HEADLESS: FIREFOX_HEADLESS ? "1" : (process.env.MOZ_HEADLESS || "")
  };
  const driver = spawn(geckoDriver, ["--port", String(GECKO_DRIVER_PORT)], {
    env: driverEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let driverOutput = "";
  function appendDriverOutput(data) {
    driverOutput = (driverOutput + data.toString()).slice(-8192);
  }
  driver.stdout.on("data", appendDriverOutput);
  driver.stderr.on("data", appendDriverOutput);

  const endpoint = `http://127.0.0.1:${GECKO_DRIVER_PORT}`;
  let sessionId = "";
  let browserCapabilities = {};
  try {
    await waitForBatonServer(server);
    await waitForWebDriver(endpoint, () => driverOutput.trim(), "geckodriver");
    const session = await newFirefoxSession(endpoint);
    sessionId = session.sessionId;
    browserCapabilities = summarizeCapabilities(session.capabilities, {
      geckoDriverVersion: (capabilities) => capabilities["moz:geckodriverVersion"] || ""
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
      expectedSentVariants: null,
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
      if (REQUIRE_PROTOCOL_CONSTRUCTOR) {
        assertDiagnosticResult("protocolConstructor", result.protocolConstructor);
      }
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
      if (REQUIRE_STREAM_WRITABLE) {
        assertDiagnosticResult("streamWritable", result.streamWritable);
      }
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
      driverText ? `geckodriver output:\n${driverText}` : ""
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
