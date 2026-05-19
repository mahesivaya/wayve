import { logger } from "../utils/logger";
import { useEffect, useRef, useState } from "react";
import { getWsBase } from "../config/env";

export default function Call() {
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);

  const [connected, setConnected] = useState(false);

  // 🔥 Create PeerConnection safely
  const createPeerConnection = () => {
    if (pcRef.current) return pcRef.current;

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
      ],
    });

    pc.onicecandidate = (event) => {
      if (event.candidate && wsRef.current) {
        wsRef.current.send(
          JSON.stringify({
            type: "ice-candidate",
            candidate: event.candidate,
          })
        );
      }
    };

    pc.ontrack = (event) => {
      logger.log("📡 Received remote stream", event.streams[0]);
      const audio = document.getElementById("remoteAudio") as HTMLAudioElement;
      if (audio) {
        audio.srcObject = event.streams[0];
      }
    };

    pcRef.current = pc;
    return pc;
  };

  // 🔥 Start WebSocket
  useEffect(() => {
    const ws = new WebSocket(`${getWsBase()}/ws/call`);
    wsRef.current = ws;

    ws.onopen = () => {
      logger.log("✅ WS connected");
      setConnected(true);
    };

    ws.onmessage = async (event) => {
      const data = JSON.parse(event.data);

      const pc = createPeerConnection();

      try {
        // 🔥 OFFER
        if (data.type === "offer") {
          logger.log("📩 Received offer");

          await pc.setRemoteDescription({
            type: "offer",
            sdp: data.sdp,
          });

          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);

          ws.send(
            JSON.stringify({
              type: "answer",
              sdp: answer.sdp,
            })
          );
        }

        // 🔥 ANSWER
        else if (data.type === "answer") {
          logger.log("📩 Received answer");

          await pc.setRemoteDescription({
            type: "answer",
            sdp: data.sdp,
          });
        }

        // 🔥 ICE
        else if (data.type === "ice-candidate") {
          logger.log("❄️ Received ICE");

          if (data.candidate) {
            await pc.addIceCandidate(data.candidate);
          }
        }
      } catch (err) {
        logger.error("❌ WebRTC error", err);
      }
    };

    ws.onclose = () => {
      logger.log("❌ WS closed");
      setConnected(false);
    };

    return () => {
      ws.close();
    };
  }, []);

  // 🔥 Start call (send offer)
  const startCall = async () => {
    const pc = createPeerConnection();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });

      stream.getTracks().forEach((track) => {
        pc.addTrack(track, stream);
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      wsRef.current?.send(
        JSON.stringify({
          type: "offer",
          sdp: offer.sdp,
        })
      );

      logger.log("📤 Sent offer");
    } catch (err) {
      logger.error("❌ startCall error", err);
    }
  };

  return (
    <div style={{ padding: 20 }}>
      <h2>Call</h2>

      <button onClick={startCall} disabled={!connected}>
        Start Call
      </button>

      <audio id="remoteAudio" autoPlay />
    </div>
  );
}
