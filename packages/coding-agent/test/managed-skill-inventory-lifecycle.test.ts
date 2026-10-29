import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	deleteManagedSkill,
	getManagedSkillsDir,
	writeManagedSkill,
} from "@oh-my-pi/pi-coding-agent/autolearn/managed-skills";
import { SkillDescriptionCatalog } from "@oh-my-pi/pi-coding-agent/extensibility/skill-descriptions";
import {
	loadSkills,
	resetActiveSkillsForTests,
	setActiveSkills,
	type Skill,
} from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { SkillProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/skill-protocol";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";

// All files and managed mutations are confined to a throwaway profile.
describe("managed skill inventory lifecycle (#37)", () => {
	let home: string;
	let cwd: string;
	let originalAgentDir: string;
	let restoreHome: () => void;
	let restoreStat: (() => void) | undefined;
	const handler = new SkillProtocolHandler();

	beforeEach(async () => {
		originalAgentDir = getAgentDir();
		home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skill-inventory-lifecycle-"));
		cwd = path.join(home, "work");
		await fs.mkdir(cwd);
		const homeSpy = spyOn(os, "homedir").mockReturnValue(home);
		restoreHome = () => homeSpy.mockRestore();
		setAgentDir(path.join(home, ".omp", "agent"));
	});

	afterEach(async () => {
		restoreStat?.();
		restoreStat = undefined;
		resetActiveSkillsForTests();
		setAgentDir(originalAgentDir);
		restoreHome();
		await fs.rm(home, { recursive: true, force: true });
	});

	async function discover(): Promise<Skill[]> {
		return (await loadSkills({ cwd, includeSkills: ["inventory-lifecycle"] })).skills;
	}

	async function create(): Promise<string> {
		const { path: file } = await writeManagedSkill({
			action: "create",
			name: "inventory-lifecycle",
			description: "Use for the original workflow.",
			body: "Original instructions.",
		});
		return file;
	}

	it("keeps create/update/delete/recreate discovery and skill URI contents in sync without cache resets", async () => {
		expect(await discover()).toEqual([]);
		await create();
		let skills = await discover();
		expect(skills).toHaveLength(1);
		expect(skills[0].description).toBe("Use for the original workflow.");
		setActiveSkills(skills);
		expect((await handler.resolve(parseInternalUrl("skill://inventory-lifecycle"))).content).toContain(
			"Original instructions.",
		);

		await writeManagedSkill({
			action: "update",
			name: "inventory-lifecycle",
			description: "Use for the updated workflow.",
			body: "Updated instructions.",
		});
		skills = await discover();
		expect(skills[0].description).toBe("Use for the updated workflow.");
		setActiveSkills(skills);
		expect((await handler.resolve(parseInternalUrl("skill://inventory-lifecycle"))).content).toContain(
			"Updated instructions.",
		);

		await deleteManagedSkill("inventory-lifecycle");
		expect(await discover()).toEqual([]);
		await create();
		expect((await discover())[0].description).toBe("Use for the original workflow.");
	});

	it("honors externally edited frontmatter instead of cached descriptions or enabled flags", async () => {
		const file = await create();
		expect(await discover()).toHaveLength(1);
		await fs.writeFile(file, "---\nname: inventory-lifecycle\ndescription: Edited description.\n---\nEdited body.\n");
		expect((await discover())[0].description).toBe("Edited description.");
		await fs.writeFile(file, "---\nname: inventory-lifecycle\ndescription: Disabled.\nenabled: false\n---\nBody.\n");
		expect(await discover()).toEqual([]);
	});

	it("retracts deleted instruction files from fresh catalogs, frozen hints, and URI completion", async () => {
		const file = await create();
		const skills = await discover();
		setActiveSkills(skills);
		const catalog = new SkillDescriptionCatalog();
		expect(catalog.render(skills)).toHaveLength(1);
		expect(catalog.snapshot(skills)).toHaveLength(1);
		// Delete just SKILL.md: the skill directory and the old session snapshot remain.
		await fs.unlink(file);
		expect(await discover()).toEqual([]);
		expect(catalog.render(skills)).toEqual([]);
		expect(catalog.snapshot(skills)).toEqual([]);
		expect(new SkillDescriptionCatalog().render(skills)).toEqual([]);
		expect(await handler.complete()).toEqual([]);
		await expect(handler.resolve(parseInternalUrl("skill://inventory-lifecycle"))).rejects.toThrow(
			/Skill resource unavailable:[\s\S]*Refresh skills/,
		);
		expect(await handler.locate(parseInternalUrl("skill://inventory-lifecycle"))).toBeNull();
		expect(await Bun.file(path.join(getManagedSkillsDir(), "inventory-lifecycle", "SKILL.md")).exists()).toBe(false);
	});

	it("gives the same actionable diagnosis when deletion races the final file read", async () => {
		const file = await create();
		const skills = await discover();
		const stat = fs.stat;
		let deleted = false;
		const statSpy = spyOn(fs, "stat").mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
			const result = await stat(...args);
			if (!deleted && path.resolve(String(args[0])) === path.resolve(file)) {
				deleted = true;
				await fs.unlink(file);
			}
			return result;
		}) as typeof fs.stat);
		restoreStat = () => statSpy.mockRestore();
		await expect(handler.resolve(parseInternalUrl("skill://inventory-lifecycle"), { skills })).rejects.toThrow(
			/Skill resource unavailable:[\s\S]*Refresh skills/,
		);
		expect(deleted).toBe(true);
	});
});
