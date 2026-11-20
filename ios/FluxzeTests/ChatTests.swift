import XCTest
@testable import Fluxze

@MainActor
final class ChatTests: XCTestCase {
    private func store(_ me: Me) -> ChatStore {
        ChatStore(api: APIClient(baseURL: URL(string: "https://fluxze.test")!), me: me)
    }

    func testDecodesTheServerShapes() throws {
        let users = try APIClient.decoder.decode([ChatUser].self, from: Data("""
        [{"id": 5, "email": "ana@x.com", "public_key": [48, 130]}, {"id": 6, "email": "bo@x.com", "public_key": null}]
        """.utf8))
        XCTAssertEqual(users.map(\.publicKey), [[48, 130], nil])
        // The by-email lookup (used to fetch a key the directory didn't have).
        let found = try APIClient.decoder.decode(ChatUser?.self, from: Data("""
        {"id": 117, "email": "new@x.com", "public_key": [48, 130], "can_message": true}
        """.utf8))
        XCTAssertEqual(found?.id, 117)
        XCTAssertEqual(found?.canMessage, true)
        XCTAssertNil(try APIClient.decoder.decode(ChatUser?.self, from: Data("null".utf8)))

        let summary = try APIClient.decoder.decode(ChatSummary.self, from: Data("""
        {"total_unread": 3, "conversations": [{"user_id": 5, "unread_count": 3, "last_message_at": "2026-11-14T10:00:00+00:00"}]}
        """.utf8))
        XCTAssertEqual(summary.totalUnread, 3)
        XCTAssertNotNil(summary.conversations.first?.lastMessageAt)

        let channels = try APIClient.decoder.decode([ChatChannel].self, from: Data("""
        [{"id": 2, "name": "general", "visibility": "public", "created_by": 1, "created_at": "2026-11-01T00:00:00Z",
          "last_message_at": null, "is_member": true, "member_ids": [1, 5], "member_emails": []}]
        """.utf8))
        XCTAssertEqual(channels.first?.memberIds, [1, 5])

        let message = try APIClient.decoder.decode(ChatWireMessage.self, from: Data("""
        {"message_id": 9, "channel_id": 2, "sender_id": 5, "sender_name": "Ana", "content": "hi",
         "status": "sent", "created_at": "2026-11-14T10:00:00+00:00", "parent_message_id": null, "reply_count": 0}
        """.utf8))
        XCTAssertEqual(message.messageId, 9)
        XCTAssertEqual(message.senderName, "Ana")
    }

    func testStandardEncryptionFollowsTheScope() {
        func me(_ type: String?, scope: String? = nil, tier: String? = nil) -> Me {
            Me(id: 1, email: "me@x.com", username: nil, accountType: type, scope: scope,
               currentPlan: tier.map { Me.Plan(tier: $0) })
        }
        XCTAssertFalse(me("personal").usesStandardChatEncryption)
        XCTAssertTrue(me("organization_admin").usesStandardChatEncryption)
        XCTAssertTrue(me("platform_admin").usesStandardChatEncryption)
        XCTAssertTrue(me("personal", scope: "organization").usesStandardChatEncryption)
        XCTAssertTrue(me("personal", tier: "enterprise").usesStandardChatEncryption)
        XCTAssertTrue(store(me("personal")).sendsEncrypted)
        XCTAssertTrue(store(me("organization")).canSend)
    }

    func testFramesGoOutInTheServerShape() throws {
        let frame = ChatWireMessage(senderId: 1, receiverId: 5, content: "hi", status: "sent", clientId: "abc")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: ChatStore.frameEncoder.encode(frame)) as? [String: Any])
        XCTAssertEqual(json["sender_id"] as? Int, 1)
        XCTAssertEqual(json["receiver_id"] as? Int, 5)
        XCTAssertEqual(json["client_id"] as? String, "abc")
        XCTAssertNil(json["channel_id"])
    }

    func testHistoryPathsAndOrder() {
        let s = store(Me(id: 1, email: "me@x.com", username: nil, accountType: "personal"))
        let ana = ChatUser(id: 5, email: "ana@x.com", publicKey: nil)
        XCTAssertEqual(s.historyPath(.dm(ana), sinceID: nil), "/api/chat/direct-messages?user1=1&user2=5")
        let general = ChatChannel(id: 2, name: "general", isMember: true, memberIds: [1, 5], lastMessageAt: nil)
        XCTAssertEqual(s.historyPath(.channel(general), sinceID: 40), "/api/chat/channel-messages?channel_id=2&since_id=40")

        let t = Date(timeIntervalSince1970: 100)
        let rows = [
            ChatWireMessage(messageId: 3, senderId: 5, content: "c", createdAt: t.addingTimeInterval(5)),
            ChatWireMessage(messageId: 2, senderId: 1, content: "b", createdAt: t),
            ChatWireMessage(messageId: 1, senderId: 5, content: "a", createdAt: t),
        ]
        XCTAssertEqual(ChatStore.sorted(rows).map(\.messageId), [1, 2, 3])
    }

    func testConversationMembership() {
        let ana = ChatUser(id: 5, email: "ana@x.com", publicKey: nil)
        let toMe = ChatWireMessage(senderId: 5, receiverId: 1, content: "hi")
        let toBo = ChatWireMessage(senderId: 5, receiverId: 6, content: "hi")
        let inChannel = ChatWireMessage(senderId: 5, channelId: 2, content: "hi")
        XCTAssertTrue(ChatConversation.dm(ana).contains(toMe, me: 1))
        XCTAssertFalse(ChatConversation.dm(ana).contains(toBo, me: 1))
        XCTAssertFalse(ChatConversation.dm(ana).contains(inChannel, me: 1))
    }

    func testPresenceLikeTheWeb() throws {
        struct Snapshot: Decodable { let presence: [ChatPresenceEntry] }
        let snapshot = try APIClient.decoder.decode(Snapshot.self, from: Data("""
        {"presence": [
          {"user_id": 5, "online": true, "last_seen": "2026-11-15T02:00:00+00:00", "status": "away"},
          {"user_id": 6, "online": false, "last_seen": "2026-11-15T01:00:00+00:00", "status": "dnd"},
          {"user_id": 7, "online": true, "last_seen": null, "status": "active"},
          {"user_id": 8, "online": false, "last_seen": null, "status": "active"}]}
        """.utf8))
        let kinds = snapshot.presence.map(\.presence.kind)
        // Offline wins over the chosen status.
        XCTAssertEqual(kinds, [.away, .offline, .active, .offline])
        XCTAssertEqual(snapshot.presence[0].presence.line(), "Away")
        XCTAssertTrue(snapshot.presence[1].presence.line().hasPrefix("Last seen"))
        XCTAssertEqual(snapshot.presence[3].presence.line(), "Offline")

        // A live frame has the same fields, plus its type.
        let frame = try APIClient.decoder.decode(ChatPresenceEntry.self, from: Data("""
        {"type": "presence", "user_id": 9, "online": true, "last_seen": null, "status": "dnd"}
        """.utf8))
        XCTAssertEqual(frame.presence.kind, .dnd)
        XCTAssertEqual(ChatStore.presencePath([5, 9]), "/api/chat/presence?ids=5,9")
    }

    func testPresenceFramesUpdateTheStore() {
        let s = store(Me(id: 1, email: "me@x.com", username: nil, accountType: "personal"))
        let ana = ChatUser(id: 5, email: "ana@x.com", publicKey: nil)
        XCTAssertNil(s.presence(for: .dm(ana)))
        s.handle(frame: Data(#"{"type":"presence","user_id":5,"online":true,"last_seen":null,"status":"away"}"#.utf8))
        XCTAssertEqual(s.presence(for: .dm(ana))?.kind, .away)
        s.handle(frame: Data(#"{"type":"presence","user_id":5,"online":false,"last_seen":null,"status":"away"}"#.utf8))
        XCTAssertEqual(s.presence(for: .dm(ana))?.kind, .offline)
    }

    func testYourOwnStatusFollowsPushes() {
        let s = store(Me(id: 1, email: "me@x.com", username: nil, accountType: "personal"))
        XCTAssertEqual(s.myStatus, "active")
        // Set on the web or desktop: the server pushes it to your own clients.
        s.handle(frame: Data(#"{"type":"presence","user_id":1,"online":true,"last_seen":null,"status":"away"}"#.utf8))
        XCTAssertEqual(s.myStatus, "away")
        // Your own row isn't listed as someone else's presence.
        XCTAssertNil(s.presence[1])
        XCTAssertFalse(s.presenceIDs.contains(1))
    }

    func testRowTimeLikeMessages() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York")!
        let now = calendar.date(from: DateComponents(year: 2026, month: 11, day: 14, hour: 21))!
        let yesterday = calendar.date(byAdding: .day, value: -1, to: now)!
        XCTAssertEqual(ConversationRow.timeLabel(yesterday, now: now, calendar: calendar), "Yesterday")
        let lastWeek = calendar.date(byAdding: .day, value: -10, to: now)!
        XCTAssertNotEqual(ConversationRow.timeLabel(lastWeek, now: now, calendar: calendar), "Yesterday")
    }

    func testDeliveryTicksOnlyMoveForward() {
        func bubble(_ id: Int, from sender: Int, _ delivery: ChatBubble.Delivery?) -> ChatBubble {
            ChatBubble(id: "m\(id)", messageId: id, clientId: nil, senderId: sender, senderName: nil,
                       body: .text("x"), createdAt: nil, delivery: delivery)
        }
        let bubbles = [bubble(1, from: 1, .sent), bubble(2, from: 1, .delivered),
                       bubble(3, from: 5, nil), bubble(4, from: 1, .read)]

        // A bulk read marks every one of my messages it names.
        let read = ChatStore.advanced(bubbles, ids: [1, 2, 3, 4], to: .read, me: 1)
        XCTAssertEqual(read?.map(\.delivery), [.read, .read, nil, .read])

        // A late "delivered" never undoes a "read", and changes nothing.
        XCTAssertNil(ChatStore.advanced(bubbles, ids: [4], to: .delivered, me: 1))
        // Someone else's message gets no tick.
        XCTAssertNil(ChatStore.advanced(bubbles, ids: [3], to: .read, me: 1))

        XCTAssertEqual(ChatBubble.Delivery("delivered"), .delivered)
        XCTAssertNil(ChatBubble.Delivery("pending"))
    }

    func testStatusFramesDecode() {
        // Frames the store ignores must not crash it, whatever the conversation.
        let s = store(Me(id: 1, email: "me@x.com", username: nil, accountType: "personal"))
        s.handle(frame: Data(#"{"type":"status_update_bulk","message_ids":[10,11],"status":"read"}"#.utf8))
        s.handle(frame: Data(#"{"type":"status_update","message_id":10,"status":"delivered"}"#.utf8))
        s.handle(frame: Data(#"{"type":"status_update_bulk","message_ids":"x","status":"read"}"#.utf8))
        XCTAssertTrue(s.bubbles.isEmpty)
    }

    func testSocketURLAndBackoff() {
        XCTAssertEqual(ChatSocket.url(base: URL(string: "https://fluxze.com")!, token: "t")?.absoluteString,
                       "wss://fluxze.com/ws/chat?token=t")
        XCTAssertEqual(ChatSocket.url(base: URL(string: "http://localhost")!, token: "t")?.absoluteString,
                       "ws://localhost/ws/chat?token=t")
        for attempt in 0..<10 {
            XCTAssertLessThanOrEqual(ChatSocket.backoff(attempt: attempt), 15 * 1.2)
        }
        XCTAssertGreaterThanOrEqual(ChatSocket.backoff(attempt: 0), 0.8)
    }
}
