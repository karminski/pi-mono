import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamSimple } from "../src/stream.js";

const mockState = vi.hoisted(() => ({
	chunks: undefined as
		| Array<{
				id?: string;
				choices?: Array<{ delta: Record<string, unknown>; finish_reason: string | null }>;
		  }>
		| undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: async (_params: unknown) => {
					return {
						async *[Symbol.asyncIterator]() {
							const chunks = mockState.chunks ?? [{ choices: [{ delta: {}, finish_reason: "stop" as const }] }];
							for (const chunk of chunks) {
								yield chunk;
							}
						},
					};
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

describe("openai-completions streaming audio (delta.audio)", () => {
	beforeEach(() => {
		mockState.chunks = undefined;
	});

	it("emits audio_start, audio_delta, audio_end and accumulates fragments", async () => {
		const { compat: _c, ...base } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...base, api: "openai-completions" as const };

		mockState.chunks = [
			{
				choices: [
					{
						delta: { content: "Hi", audio: { id: "a1", data: "AAA" } },
						finish_reason: null,
					},
				],
			},
			{
				choices: [
					{
						delta: { audio: { id: "a1", data: "BBB", transcript: "you" } },
						finish_reason: null,
					},
				],
			},
			{ choices: [{ delta: {}, finish_reason: "stop" }] },
		];

		const events: string[] = [];
		const stream = streamSimple(
			model,
			{ messages: [{ role: "user", content: "x", timestamp: Date.now() }] },
			{ apiKey: "k" },
		);

		for await (const e of stream) {
			events.push(e.type);
		}

		const msg = await stream.result();
		expect(events.filter((t) => t === "audio_start").length).toBe(1);
		expect(events.filter((t) => t === "audio_delta").length).toBe(2);
		expect(events.filter((t) => t === "audio_end").length).toBe(1);

		const audio = msg.content.filter((b) => b.type === "audio");
		expect(audio).toHaveLength(1);
		expect(audio[0]).toMatchObject({
			type: "audio",
			fragments: ["AAA", "BBB"],
			streamId: "a1",
			transcript: "you",
		});
	});

	it("starts a new audio block when stream id changes", async () => {
		const { compat: _c, ...base } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...base, api: "openai-completions" as const };

		mockState.chunks = [
			{
				choices: [{ delta: { audio: { id: "s1", data: "AA" } }, finish_reason: null }],
			},
			{
				choices: [{ delta: { audio: { id: "s2", data: "BB" } }, finish_reason: null }],
			},
			{ choices: [{ delta: {}, finish_reason: "stop" }] },
		];

		const types: string[] = [];
		const stream = streamSimple(
			model,
			{ messages: [{ role: "user", content: "x", timestamp: Date.now() }] },
			{ apiKey: "k" },
		);
		for await (const e of stream) {
			types.push(e.type);
		}
		const msg = await stream.result();

		expect(types.filter((t) => t === "audio_start").length).toBe(2);
		expect(types.filter((t) => t === "audio_end").length).toBe(2);

		const blocks = msg.content.filter((b) => b.type === "audio") as Array<{
			fragments: string[];
			streamId?: string;
		}>;
		expect(blocks).toHaveLength(2);
		expect(blocks[0]?.fragments).toEqual(["AA"]);
		expect(blocks[0]?.streamId).toBe("s1");
		expect(blocks[1]?.fragments).toEqual(["BB"]);
		expect(blocks[1]?.streamId).toBe("s2");
	});
});
