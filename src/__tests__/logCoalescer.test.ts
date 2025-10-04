import {describe, it, expect} from "vitest";
import {appendMessage, canMergeMessages, type ChatMessage} from "../lib/logCoalescer";

const m = (p: Partial<ChatMessage> = {}): ChatMessage => ({
    connection_id: "c1",
    target: "#main",
    sender: "j",
    message: "x",
    kind: "join",
    timestamp: 1,
    ...p,
});

describe("canMergeMessages", () => {
    it("mergesWhenKindSenderTargetMessageMatch", () => {
        const a = m({kind: "topic", message: "Hope you guys are doing well! [Sep 2025]"});
        const b = m({kind: "topic", message: "Hope you guys are doing well! [Sep 2025]"});
        expect(canMergeMessages(a, b)).toBe(true);
    });

    it("doesNotMergeDifferentKind", () => {
        expect(canMergeMessages(m({kind: "join"}), m({kind: "part"}))).toBe(false);
    });

    it("doesNotMergePrivmsgOrAction", () => {
        expect(canMergeMessages(m({kind: "privmsg"}), m({kind: "privmsg"}))).toBe(false);
        expect(canMergeMessages(m({kind: "action"}), m({kind: "action"}))).toBe(false);
    });

    it("mergesWhenSenderNullishEqual", () => {
        const a = m({kind: "join", sender: undefined, message: "joined #main"});
        const b = m({kind: "join", sender: null, message: "joined #main"});
        expect(canMergeMessages(a, b)).toBe(true);
    });

    it("doesNotMergeDifferentSender", () => {
        expect(canMergeMessages(m({sender: "alice"}), m({sender: "bob"}))).toBe(false);
    });

    it("doesNotMergeDifferentTarget", () => {
        expect(canMergeMessages(m({target: "#main"}), m({target: "#other"}))).toBe(false);
    });

    it("doesNotMergeDifferentMessage", () => {
        expect(canMergeMessages(m({message: "A"}), m({message: "B"}))).toBe(false);
    });
});

describe("appendMessage", () => {
    it("coalescesAndIncrementsRepeatCount", () => {
        const a = m({kind: "join", message: "j joined #main", timestamp: 1});
        const b = m({kind: "topic", message: "Hope you guys are doing well! [Sep 2025]", timestamp: 2});
        const c = m({kind: "join", message: "j joined #main", timestamp: 3});
        const d = m({kind: "topic", message: "Hope you guys are doing well! [Sep 2025]", timestamp: 4});
        let out: ChatMessage[] = [];
        out = appendMessage(out, a, 5000);
        out = appendMessage(out, b, 5000);
        out = appendMessage(out, c, 5000);
        out = appendMessage(out, d, 5000);
        expect(out).toHaveLength(2);
        const rc0 = ((out[0].metadata as any)?.repeatCount ?? 1);
        const rc1 = ((out[1].metadata as any)?.repeatCount ?? 1);
        expect(rc0).toBe(2);
        expect(rc1).toBe(2);
        expect(out[0].timestamp).toBe(3);
        expect(out[1].timestamp).toBe(4);
    });

    it("respectsLimitAndDropsOldest", () => {
        let out: ChatMessage[] = [];
        for (let i = 0; i < 3; i += 1) {
            out = appendMessage(out, m({message: `m${i}`, timestamp: i}), 2);
        }
        expect(out.map(x => x.message)).toEqual(["m1", "m2"]);
    });
});
