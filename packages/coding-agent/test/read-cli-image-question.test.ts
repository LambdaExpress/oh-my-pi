/**
 * `omp read <image>?q=<question>` delegates to a vision model, which requires a
 * model registry to resolve modelRoles.vision / @default and fetch credentials.
 * The read CLI built a lightweight session with no registry, so the read tool
 * aborted with "Model registry is unavailable for image questions." before any
 * resolution (issue #11338). This drives the real `omp read` command in an
 * isolated agent dir carrying competing model roles and a local vision
 * provider, then verifies the submitted model, image, question, and answer.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

// 1x1 PNG so the read tool's image loader accepts the file.
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

function modelsYaml(baseUrl: string): string {
	return `providers:
  testvision:
    api: openai-completions
    baseUrl: ${baseUrl}
    apiKey: "test-key"
    models:
      - id: default-vision
        name: Default Vision
        input:
          - text
          - image
        contextWindow: 128000
        maxTokens: 4096
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
      - id: vmodel
        name: Vision Test
        input:
          - text
          - image
        contextWindow: 128000
        maxTokens: 4096
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
`;
}

const CLI_ENTRY = path.join(import.meta.dir, "..", "src", "cli.ts");

describe("omp read <image>?q=", () => {
	it("submits the image and question to the vision role and prints its answer", async () => {
		using tempDir = TempDir.createSync("@pi-read-cli-imgq-");
		const question = "describe this image";
		const answer = "A single pixel.";
		const requests: Array<{ path: string; authorization: string | null; body: unknown }> = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const pathname = new URL(request.url).pathname;
				if (request.method !== "POST" || pathname !== "/v1/chat/completions") {
					return new Response("Unexpected vision route", { status: 404 });
				}
				const body: unknown = await request.json();
				requests.push({ path: pathname, authorization: request.headers.get("authorization"), body });
				const chunks = [
					{
						id: "vision-answer",
						object: "chat.completion.chunk",
						created: 1,
						model: "vmodel",
						choices: [{ index: 0, delta: { role: "assistant", content: answer }, finish_reason: null }],
					},
					{
						id: "vision-answer",
						object: "chat.completion.chunk",
						created: 1,
						model: "vmodel",
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					},
				];
				return new Response(
					chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
					{
						headers: { "content-type": "text/event-stream" },
					},
				);
			},
		});
		try {
			const agentDir = tempDir.join("agent");
			const home = tempDir.join("home");
			const project = tempDir.join("project");
			await fs.mkdir(home);
			await Bun.write(
				path.join(project, ".omp", "config.yml"),
				"modelRoles:\n  default: testvision/default-vision\n  vision: testvision/vmodel\nimages:\n  autoResize: false\n",
			);
			await Bun.write(path.join(agentDir, "models.yml"), modelsYaml(new URL("/v1", server.url).href));
			const pngPath = path.join(project, "test.png");
			await Bun.write(pngPath, Buffer.from(PNG_1X1, "base64"));

			const child = Bun.spawn(
				[process.execPath, CLI_ENTRY, "read", `${pngPath}?q=${encodeURIComponent(question)}`],
				{
					cwd: project,
					env: {
						...process.env,
						HOME: home,
						USERPROFILE: home,
						OMP_PROFILE: "",
						PI_PROFILE: "",
						PI_CODING_AGENT_DIR: agentDir,
						PI_TEST_RUNTIME: "1",
						NO_COLOR: "1",
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(exitCode).toBe(0);
			expect(stderr).toBe("");
			expect(stdout).toContain(answer);
			expect(requests).toEqual([
				{
					path: "/v1/chat/completions",
					authorization: "Bearer test-key",
					body: expect.objectContaining({
						model: "vmodel",
						messages: expect.arrayContaining([
							expect.objectContaining({
								role: "user",
								content: expect.arrayContaining([
									{ type: "text", text: question },
									expect.objectContaining({
										type: "image_url",
										image_url: expect.objectContaining({
											url: `data:image/png;base64,${PNG_1X1}`,
										}),
									}),
								]),
							}),
						]),
					}),
				},
			]);
		} finally {
			await server.stop(true);
		}
	}, 60_000);
});
