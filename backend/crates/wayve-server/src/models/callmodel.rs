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
    // Ring/accept flow only: `media` tells the callee which UI to render and
    // `from_email` identifies the caller without a lookup. The offer, answer, and
    // ICE relay pass both through unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_email: Option<String>,
}

// `rename_all = "camelCase"` is load-bearing: the browser's
// `RTCIceCandidate.toJSON()` emits camelCase keys. Without the rename these
// fields deserialize as missing and are relayed back as snake_case, so the peer's
// `addIceCandidate` rejects every candidate and media never flows.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IceCandidate {
    pub candidate: String,
    pub sdp_mid: Option<String>,
    pub sdp_m_line_index: Option<u16>,
    pub username_fragment: Option<String>,
}
