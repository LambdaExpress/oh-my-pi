import { describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { attachIrcWakeTurnMonitor } from "@oh-my-pi/pi-coding-agent/task/executor";
import { Snowflake, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

describe("IRC wake-turn relay", () => {
	it("delivers an idle peer's final answer once without relaying the recipient's consumption back", async () => {
		await using tempDir = await TempDir.create("@omp-irc-relay-consumer-");
		const registry = AgentRegistry.global();
		const bus = IrcBus.global();
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"contextPromotion.enabled": false,
			"retry.enabled": false,
			"features.unexpectedStopDetection": "none",
			"advisor.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"power.sleepPrevention": "off",
		});
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "local-relay-fixture-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"), { settings });
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected the bundled session fixture model");
		const sessions: AgentSession[] = [];
		const ids: string[] = [];
		const makeSession = (answer: string) => {
			const id = `RelayPeer${Snowflake.next()}`;
			const mock = createMockModel({ responses: [{ content: [answer] }] });
			const inputs: string[][] = [];
			const session = new AgentSession({
				agent: new Agent({
					initialState: { model, systemPrompt: ["Consume peer findings"], tools: [] },
					convertToLlm,
					streamFn: (activeModel, context, options) => {
						inputs.push(
							context.messages.map(message => {
								if (message.role === "assistant") {
									return message.content
										.filter(part => part.type === "text")
										.map(part => part.text)
										.join("");
								}
								return typeof message.content === "string"
									? message.content
									: message.content
											.filter(part => part.type === "text")
											.map(part => part.text)
											.join("");
							}),
						);
						return mock.stream(activeModel, context, options);
					},
				}),
				sessionManager: SessionManager.inMemory(tempDir.path()),
				settings,
				modelRegistry,
				agentId: id,
				agentKind: "sub",
				memoryEnabled: false,
			});
			registry.register({ id, displayName: "task", kind: "sub", session, status: "idle" });
			session.addDisposer(session.subscribeRunState(state => registry.setStatus(id, state, session)));
			attachIrcWakeTurnMonitor(session, {
				id,
				agent: { name: "task", description: "relay consumer", systemPrompt: "test", source: "bundled" },
			});
			sessions.push(session);
			ids.push(id);
			return { id, session, inputs };
		};
		try {
			const sender = makeSession("The answer was consumed; no reply is needed.");
			const recipient = makeSession("The constraint evidence is complete.");
			const receipt = await bus.send({
				from: sender.id,
				to: recipient.id,
				body: "Report the completed constraint evidence.",
			});
			expect(receipt.outcome).toBe("woken");
			await recipient.session.waitForIdle();
			await recipient.session.waitForIrcReplies();
			await sender.session.waitForIdle();
			await sender.session.waitForIrcReplies();

			expect(recipient.inputs).toHaveLength(1);
			expect(recipient.inputs[0]!.join("\n").split("Report the completed constraint evidence.")).toHaveLength(2);
			expect(sender.inputs).toHaveLength(1);
			expect(sender.inputs[0]!.join("\n").split("The constraint evidence is complete.")).toHaveLength(2);
			expect(recipient.session.getLastAssistantText()).toBe("The constraint evidence is complete.");
			expect(sender.session.getLastAssistantText()).toBe("The answer was consumed; no reply is needed.");
			const answer = sender.session.messages.find(
				message => message.role === "custom" && message.customType === "irc:incoming",
			);
			expect(answer?.role === "custom" && answer.details).toMatchObject({ from: recipient.id, wakeRelay: true });
			expect(bus.inbox(sender.id)).toEqual([]);
			expect(bus.inbox(recipient.id)).toEqual([]);
			expect(sender.session.drainPendingIrcInboxMessages(sender.id)).toEqual([]);
			expect(recipient.session.drainPendingIrcInboxMessages(recipient.id)).toEqual([]);
		} finally {
			for (const session of sessions) await session.dispose();
			for (const id of ids) registry.unregister(id);
			authStorage.close();
		}
	});
});
