import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ptree, TempDir } from "@oh-my-pi/pi-utils";

// Exercise the CLI in an isolated repository: upstream intentionally keeps
// runner helpers private, and importing it would execute the real repo suite.
async function createRunnerFixture(dir: TempDir, count: number, firstTest?: string): Promise<string[]> {
	await Bun.write(dir.join("scripts/ci-test-ts.ts"), Bun.file(path.join(import.meta.dir, "ci-test-ts.ts")));
	const names: string[] = [];
	for (let index = 0; index < count; index++) {
		const name = `native-case-${String(index).padStart(3, "0")}`;
		names.push(name);
		await Bun.write(
			dir.join(`packages/coding-agent/test/${name}.test.ts`),
			index === 0 && firstTest
				? firstTest
				: `import { test } from "bun:test";\nimport { appendFileSync } from "node:fs";\ntest(${JSON.stringify(name)}, () => appendFileSync(${JSON.stringify(dir.join("completed"))}, ${JSON.stringify(`${name}\n`)}));\n`,
		);
	}
	return names;
}

function runFixture(dir: TempDir, env: Record<string, string> = {}) {
	return ptree.exec([process.execPath, dir.join("scripts/ci-test-ts.ts"), "coding-agent-native"], {
		cwd: dir.join("."),
		env: {
			...Bun.env,
			PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
			CI: "1",
			OMP_TEST_SHARD: "",
			OMP_TEST_CONCURRENCY: "1",
			OMP_TEST_CHUNK_TIMEOUT: "10",
			NO_COLOR: "1",
			...env,
		},
		timeout: 15_000,
		detached: true,
		allowNonZero: true,
	});
}

async function completed(dir: TempDir): Promise<string[]> {
	const file = Bun.file(dir.join("completed"));
	if (!(await file.exists())) return [];
	return (await file.text()).trim().split("\n").filter(Boolean).sort();
}

describe("test runner watchdog", () => {
	// Fake timers cannot drive the watchdog in the isolated runner process.
	test("kills a stalled chunk, reports failure, and continues the queue", async () => {
		using dir = TempDir.createSync("@omp-test-runner-watchdog-");
		await createRunnerFixture(
			dir,
			11,
			`import { test } from "bun:test";\ntest("stalled", async () => {\nawait Bun.write(${JSON.stringify(dir.join("started"))}, "started");\nawait Bun.sleep(60_000);\nawait Bun.write(${JSON.stringify(dir.join("unexpected-completion"))}, "completed");\n}, 120_000);\n`,
		);
		const result = await runFixture(dir, { OMP_TEST_CHUNK_TIMEOUT: "1" });
		expect(result.exitCode).toBe(1);
		expect(await Bun.file(dir.join("started")).text()).toBe("started");
		expect(await Bun.file(dir.join("unexpected-completion")).exists()).toBe(false);
		expect(await completed(dir)).toContain("native-case-010");
	}, 20_000);
});

describe("OMP_TEST_SHARD", () => {
	test("partitions every test chunk exactly once through the public CLI", async () => {
		using dir = TempDir.createSync("@omp-test-runner-shards-");
		const names = await createRunnerFixture(dir, 21);
		const parallelEnv = { OMP_TEST_CONCURRENCY: "3" };
		const whole = await runFixture(dir, parallelEnv);
		expect(whole.exitCode, whole.stdout + whole.stderr).toBe(0);
		expect(await completed(dir)).toEqual(names);
		await fs.rm(dir.join("completed"));
		for (let index = 1; index <= 3; index++) {
			const result = await runFixture(dir, { ...parallelEnv, OMP_TEST_SHARD: `${index}/3` });
			expect(result.exitCode, result.stdout + result.stderr).toBe(0);
		}
		expect(await completed(dir)).toEqual(names);
		await fs.rm(dir.join("completed"));
		const single = await runFixture(dir, { ...parallelEnv, OMP_TEST_SHARD: "1/1" });
		expect(single.exitCode, single.stdout + single.stderr).toBe(0);
		expect(await completed(dir)).toEqual(names);
	}, 60_000);

	test("rejects malformed and empty shard selections without executing tests", async () => {
		using dir = TempDir.createSync("@omp-test-runner-invalid-shard-");
		await createRunnerFixture(dir, 1);
		for (const spec of ["0/2", "3/2", "1/0", "2", "a/b", "1/2/3", "2/2"]) {
			const result = await runFixture(dir, { OMP_TEST_SHARD: spec });
			expect(result.exitCode, spec).not.toBe(0);
			expect(await completed(dir)).toEqual([]);
		}
	}, 60_000);
});
