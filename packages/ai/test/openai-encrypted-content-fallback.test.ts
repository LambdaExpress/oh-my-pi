import { describe, expect, it, vi } from "bun:test";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type {
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	FetchImpl,
	Model,
	ProviderSessionState,
} from "@oh-my-pi/pi-ai/types";
import { createOpenAIResponsesHistoryPayload } from "@oh-my-pi/pi-ai/utils";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const model = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;

function userMessage(content: string, timestamp: number): Context["messages"][number] {
	return { role: "user", content, timestamp };
}

function createCompletedResponse(id: string): Response {
	const events = [
		{ type: "response.created", response: { id, status: "in_progress" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: `msg_${id}`, role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.output_text.delta", output_index: 0, item_id: `msg_${id}`, delta: "ok" },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: `msg_${id}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "ok" }],
			},
		},
		{ type: "response.completed", response: { id, status: "completed" } },
	];
	return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function invalidEncryptedContentResponse(): Response {
	return new Response(
		JSON.stringify({
			error: {
				message: "Invalid value for 'input[1].encrypted_content': could not decrypt the provided content.",
				type: "invalid_request_error",
				param: "input[1].encrypted_content",
				code: "invalid_encrypted_content",
			},
		}),
		{ status: 400, headers: { "content-type": "application/json" } },
	);
}

function unrelatedBadRequestResponse(): Response {
	return new Response(
		JSON.stringify({
			error: {
				message: "Missing required parameter: 'model'.",
				type: "invalid_request_error",
				param: "model",
			},
		}),
		{ status: 400, headers: { "content-type": "application/json" } },
	);
}

function assistantWithEncryptedReasoning(encryptedContent: string, timestamp: number) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "ignored" }],
		api: "openai-responses" as const,
		provider: "openai",
		model: "gpt-5-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		providerPayload: createOpenAIResponsesHistoryPayload("openai", [
			{ type: "reasoning", id: "rs_replay", summary: [], encrypted_content: encryptedContent },
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "prior turn" }] },
		]),
		timestamp,
	};
}

function requestsEncryptedReasoning(request: Record<string, unknown> | undefined): boolean {
	const include = request?.include;
	return Array.isArray(include) && include.includes("reasoning.encrypted_content");
}

async function collectEvents(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("OpenAI Responses encrypted reasoning rejection", () => {
	it("retries once without the encrypted include and without replayed ciphertext", async () => {
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			sentRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			switch (sentRequests.length) {
				case 1:
					return createCompletedResponse("resp_warm");
				case 2:
					return invalidEncryptedContentResponse();
				default:
					return createCompletedResponse(`resp_healed_${sentRequests.length}`);
			}
		}) as FetchImpl;
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options = {
			apiKey: "test-key",
			fetch: fetchMock,
			providerSessionState,
			sessionId: "encrypted-reasoning-fallback-session",
			statefulResponses: false,
		};

		// Warm the session so the next turn replays native history (and therefore
		// the reasoning ciphertext) instead of rebuilding it.
		const warm = await streamOpenAIResponses(
			model,
			{ messages: [userMessage("first question", 1_000)] },
			options,
		).result();
		expect(warm.stopReason).toBe("stop");

		const healedStream = streamOpenAIResponses(
			model,
			{
				messages: [
					userMessage("first question", 1_000),
					assistantWithEncryptedReasoning("enc_ciphertext", 1_001),
					userMessage("second question", 1_002),
				],
			},
			options,
		);
		const healedEvents = await collectEvents(healedStream);
		const healed = await healedStream.result();

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(requestsEncryptedReasoning(sentRequests[1])).toBe(true);
		expect(JSON.stringify(sentRequests[1]?.input)).toContain("enc_ciphertext");
		expect(requestsEncryptedReasoning(sentRequests[2])).toBe(false);
		expect(JSON.stringify(sentRequests[2]?.input)).not.toContain("enc_ciphertext");
		expect(healed.stopReason).toBe("stop");
		expect(healedEvents.at(-1)?.type).toBe("done");

		// The rejection is remembered for the endpoint: later turns never replay
		// encrypted reasoning again, and never pay another 400.
		const followUp = await streamOpenAIResponses(
			model,
			{
				messages: [
					userMessage("first question", 1_000),
					assistantWithEncryptedReasoning("enc_ciphertext", 1_001),
					userMessage("second question", 1_002),
					assistantWithEncryptedReasoning("enc_second", 1_003),
					userMessage("third question", 1_004),
				],
			},
			options,
		).result();

		expect(followUp.stopReason).toBe("stop");
		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(requestsEncryptedReasoning(sentRequests[3])).toBe(false);
		expect(JSON.stringify(sentRequests[3]?.input)).not.toContain("enc_second");
		expect(JSON.stringify(sentRequests[3]?.input)).not.toContain("enc_ciphertext");
	});

	it("does not retry unrelated 400 rejections", async () => {
		const fetchMock = vi.fn(async () => unrelatedBadRequestResponse()) as FetchImpl;

		const result = await streamOpenAIResponses(
			model,
			{ messages: [userMessage("hello", 1_000)] },
			{ apiKey: "test-key", fetch: fetchMock },
		).result();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(400);
		expect(result.errorMessage).toContain("Missing required parameter");
	});
});
