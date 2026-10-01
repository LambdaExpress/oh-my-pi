import { beforeAll, describe, expect, it } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme();
});

for (const command of ["plan", "goal"] as const) {
	describe(`/${command} draft lifecycle`, () => {
		it("clears the submitted text while awaiting a mode decision without recording a prompt", async () => {
			const editor = new CustomEditor(getEditorTheme());
			const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
			const imageLinks = ["file:///fixture.png"];
			const decision = Promise.withResolvers<boolean>();
			editor.addToHistory("earlier prompt");
			editor.setText(`/${command} hello world`);
			editor.pendingImages = [image];
			editor.pendingImageLinks = [...imageLinks];
			editor.imageLinks = editor.pendingImageLinks;
			const ctx = {
				editor,
				handlePlanModeCommand: () => decision.promise,
				handleGoalModeCommand: () => decision.promise,
			} as unknown as InteractiveModeContext;

			const pending = executeBuiltinSlashCommand(`/${command} hello world`, {
				ctx,
				input: { images: [image], imageLinks },
			});
			try {
				expect(editor.getText()).toBe("");
				expect(editor.pendingImages).toEqual([]);
				expect(editor.pendingImageLinks).toEqual([]);
			} finally {
				decision.resolve(false);
				await pending;
			}

			// An exit/cancel decision did not submit a prompt: retain the attachments
			// and leave the prior prompt as the newest recallable history entry.
			expect(editor.getText()).toBe("");
			expect(editor.pendingImages).toEqual([image]);
			expect(editor.pendingImageLinks).toEqual(imageLinks);
			editor.handleInput("\x1b[A");
			expect(editor.getText()).toBe("earlier prompt");
		});
	});
}
