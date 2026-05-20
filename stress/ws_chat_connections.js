// WebSocket connection stress test for /ws/chat.
//
// What this exercises that nothing else does:
//   - The ws_registry SESSIONS map under concurrent register/unregister load —
//     a leak there would otherwise be invisible until prod fills up.
//   - The actix-web-actors per-connection allocation path.
//   - The DB pool when N concurrent JWT-auth lookups land at once.
//
// What it does NOT exercise: message broadcast / fanout latency. That needs
// real E2E-encrypted envelopes (each recipient pubkey), which is too much
// setup for a nightly stress run. Connection-layer health is the high-signal
// half of the WS stack.
//
// Run locally against the docker stack:
//   API_BASE=http://localhost:8080 WS_BASE=ws://localhost:8080 k6 run stress/ws_chat_connections.js

import { check, sleep } from "k6";
import http from "k6/http";
import ws from "k6/ws";
import { Rate, Trend } from "k6/metrics";
import { randomString } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";

const API_BASE = __ENV.API_BASE || "http://localhost:8080";
const WS_BASE = __ENV.WS_BASE || "ws://localhost:8080";
// Hold each connection open this long, in seconds, to simulate a real user
// sitting in chat. 60s is enough to surface a slow leak; longer is wasteful.
const HOLD_SECONDS = Number(__ENV.HOLD_SECONDS || 60);
// Peak concurrent connections. 200 is comfortable on ubuntu-latest
// (2-core / 7GB); push higher only after baselining locally.
const PEAK_VUS = Number(__ENV.PEAK_VUS || 200);

// Custom metrics — k6 will summarize p95/p99 and threshold against them.
const registerSuccess = new Rate("register_success");
const wsConnectSuccess = new Rate("ws_connect_success");
const wsHandshakeMs = new Trend("ws_handshake_ms", true);

export const options = {
  // Ramp up gradually so we measure both steady-state and the connect storm.
  stages: [
    { duration: "30s", target: PEAK_VUS },
    { duration: "60s", target: PEAK_VUS },
    { duration: "15s", target: 0 },
  ],
  // Fail the run (and therefore the GitHub Actions job) if any of these
  // budgets are breached. These are the regression alarms.
  thresholds: {
    register_success: ["rate>0.99"],
    ws_connect_success: ["rate>0.99"],
    "ws_handshake_ms": ["p(95)<1500", "p(99)<3000"],
    // Default http_req_failed: anything above 1% indicates a backend regression.
    http_req_failed: ["rate<0.01"],
  },
  // Default each iteration's max-duration generously — we hold connections
  // for HOLD_SECONDS, so the iteration must outlast that.
  noConnectionReuse: false,
};

function registerUser() {
  const email = `stress-${__VU}-${randomString(8)}@example.test`;
  const password = "stress-password-123";

  const res = http.post(
    `${API_BASE}/api/register`,
    JSON.stringify({
      email,
      password,
      confirm_password: password,
    }),
    { headers: { "Content-Type": "application/json" }, tags: { name: "register" } },
  );

  const ok = check(res, {
    "register 200": (r) => r.status === 200,
    "register has token": (r) => !!r.json("token"),
  });
  registerSuccess.add(ok);
  if (!ok) {
    return null;
  }
  return res.json("token");
}

export default function () {
  const token = registerUser();
  if (!token) {
    // Bail this iteration — registerSuccess already recorded the failure.
    sleep(1);
    return;
  }

  const url = `${WS_BASE}/ws/chat?token=${encodeURIComponent(token)}`;
  const start = Date.now();
  let opened = false;

  const res = ws.connect(url, {}, function (socket) {
    socket.on("open", () => {
      opened = true;
      wsHandshakeMs.add(Date.now() - start);

      // Send a ping every 10s for the duration of the hold. The chat handler
      // ignores unknown payloads but still has to deserialize them, so this
      // exercises the per-connection actix-actor message loop.
      socket.setInterval(() => {
        socket.send(JSON.stringify({ type: "ping", t: Date.now() }));
      }, 10_000);

      socket.setTimeout(() => {
        socket.close();
      }, HOLD_SECONDS * 1000);
    });

    socket.on("error", (err) => {
      // Surface in the run output; the threshold check below counts it.
      console.warn(`ws error vu=${__VU}: ${err}`);
    });
  });

  // ws.connect returns once the socket has closed; status 101 = Switching
  // Protocols (the handshake completed).
  const handshakeOk = check(res, {
    "ws upgrade 101": (r) => r && r.status === 101,
  });
  wsConnectSuccess.add(handshakeOk && opened);
}
