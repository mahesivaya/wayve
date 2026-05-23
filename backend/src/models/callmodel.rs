use actix::Message;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Message, Clone)]
#[rtype(result = "()")]
pub struct SignalMessage {
    pub r#type: String,
    pub to: i32,
    pub from: Option<i32>,
    pub sdp: Option<String>,
    pub candidate: Option<IceCandidate>,
    // Optional fields used by the ring/accept flow. `media` carries
    // "audio" | "video" on a `call-invite` so the callee can render the
    // right UI; `from_email` lets the callee show the caller's identity
    // without an extra lookup. Both are ignored by the offer/answer/ice
    // relay and pass through unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_email: Option<String>,
}

// `rename_all = "camelCase"` is load-bearing: the browser's
// `RTCIceCandidate.toJSON()` produces camelCase keys (`sdpMid`,
// `sdpMLineIndex`, `usernameFragment`). Without this rename the Rust
// deserializer silently drops them as missing, then re-serializes them as
// snake_case for the peer — `addIceCandidate` on the receiving side throws
// "Candidate missing values for both sdpMid and sdpMLineIndex" and the call
// connects but never gets remote ICE candidates, so media never flows.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IceCandidate {
    pub candidate: String,
    pub sdp_mid: Option<String>,
    pub sdp_m_line_index: Option<u16>,
    pub username_fragment: Option<String>,
}
