import { findChatUserByEmail, type ChatUser } from "../api/chat";
import { loadPublicKey } from "../crypto/keyStore";
import { logger } from "../utils/logger";
import { usesStandardChatEncryption } from "./chatPolicy";
import { encryptChatContent } from "./e2ee";
import type { Conversation } from "./types";

type PublicKeyBytes = number[] | ArrayBuffer | Uint8Array;

// Shared by the Chat page and the app-wide reply popups, so both encrypt for the
// same set of people.
//
// The sender's own key is always included, so they can read their message on
// their other devices. A DM refuses to send when the peer has no published key.
// A channel skips keyless members rather than blocking everyone.
export async function recipientPublicKeys(
  myId: number,
  conversation: Conversation,
  directory: ChatUser[]
): Promise<Map<number, PublicKeyBytes>> {
  const keys = new Map<number, PublicKeyBytes>();
  const currentUserPublicKey = await loadPublicKey(myId);
  if (!currentUserPublicKey) {
    throw new Error("Your chat encryption key is not available on this device");
  }
  keys.set(myId, currentUserPublicKey);

  if (conversation.type === "user") {
    // The directory may be older than the peer's key, so re-check the server
    // before refusing.
    const peerKey = conversation.user.public_key?.length
      ? conversation.user.public_key
      : (await findChatUserByEmail(conversation.user.email).catch(() => null))
          ?.public_key;
    if (peerKey?.length) {
      keys.set(conversation.user.id, peerKey);
    } else {
      throw new Error(
        `Can't send — ${conversation.user.email} hasn't set up encryption yet. ` +
          `They just need to open Wayve once.`
      );
    }
    return keys;
  }

  // Members without a published key (never opened Wayve, or not in this user's
  // directory) are skipped rather than blocking the whole channel. Their envelope
  // has no entry for them, so they see a "sent before you set up encryption"
  // placeholder for these messages.
  for (const memberId of conversation.channel.member_ids) {
    if (memberId === myId) continue;
    const member = directory.find((candidate) => candidate.id === memberId);
    if (member?.public_key?.length) {
      keys.set(memberId, member.public_key);
    } else {
      logger.info(
        `Channel member ${member?.email ?? `#${memberId}`} has no encryption key; skipping`
      );
    }
  }
  return keys;
}

type SenderPolicy = Parameters<typeof usesStandardChatEncryption>[0] & {
  id: number;
};

// The wire content for a text-only message: plain text for organization and
// platform accounts (protected by the server's at-rest layer), otherwise an
// end-to-end envelope.
export async function encryptTextForSend(
  user: SenderPolicy,
  conversation: Conversation,
  directory: ChatUser[],
  plaintext: string
): Promise<string> {
  if (usesStandardChatEncryption(user)) return plaintext;
  const keys = await recipientPublicKeys(user.id, conversation, directory);
  if (keys.size === 0) throw new Error("No chat encryption keys are available");
  return encryptChatContent(plaintext, keys);
}
