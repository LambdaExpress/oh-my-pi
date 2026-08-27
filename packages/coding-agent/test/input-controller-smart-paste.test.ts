/**
 * Smart paste (#1628): `app.clipboard.pasteImage` must fall back to pasting
 * clipboard text when no image is available, instead of dead-ending with
 * "No image in clipboard". Hosts that deliver only this one chord (VS Code's
 * integrated terminal forwarding Ctrl+V, Windows clipboard history via Win+V)
 * rely on the fallback to cover both payload kinds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { setLocale } from "../src/i18n";

beforeEach(() => setLocale("en"));
afterEach(() => setLocale(null));

function createContext(options?: { focused?: { pasteText(text: string): void } }) {
	const pasteText = vi.fn();
	const insertText = vi.fn();
	const insertAtom = vi.fn();
	const putBlob = vi.fn(async (_data: Buffer, _options?: { extension?: string }) => ({
		displayPath: "C:\\omp-cache\\clipboard.png",
	}));
	const requestRender = vi.fn();
	const showStatus = vi.fn();
	const ctx = {
		editor: { pasteText, insertText, insertAtom } as unknown as InteractiveModeContext["editor"],
		sessionManager: { putBlob } as unknown as InteractiveModeContext["sessionManager"],
		ui: { requestRender, getFocused: () => options?.focused ?? null } as unknown as InteractiveModeContext["ui"],
		showStatus,
	} as unknown as InteractiveModeContext;
	return { ctx, spies: { pasteText, insertText, insertAtom, putBlob, requestRender, showStatus } };
}

describe("InputController.handleImagePaste smart-paste fallback", () => {
	it("prefers the clipboard image and never consults text when an image is present", async () => {
		const { ctx, spies } = createContext();
		const readText = vi.fn(async () => "text that must not be pasted");
		const controller = new InputController(ctx, {
			// Unsupported/undecodable payload keeps the test off the full image
			// pipeline; the contract under test is the read order, and that an
			// image failure must NOT silently degrade into a text paste.
			readImage: async () => ({ data: Buffer.from("not an image"), mimeType: "image/tiff" }),
			readText,
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(false);
		expect(readText).not.toHaveBeenCalled();
		expect(spies.pasteText).not.toHaveBeenCalled();
		expect(spies.showStatus).toHaveBeenCalledWith("Unsupported clipboard image format: image/tiff");
	});

	it("attaches nothing and pastes clipboard text when no image is present", async () => {
		const { ctx, spies } = createContext();
		const controller = new InputController(ctx, {
			readImage: async () => null,
			readText: async () => "copied text\nsecond line",
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		expect(spies.pasteText).toHaveBeenCalledWith("copied text\nsecond line");
		expect(spies.requestRender).toHaveBeenCalled();
		expect(spies.showStatus).not.toHaveBeenCalled();
	});

	it("routes the text fallback to a focused paste-capable component (#2127 contract)", async () => {
		const focusedPasteText = vi.fn();
		const { ctx, spies } = createContext({ focused: { pasteText: focusedPasteText } });
		const controller = new InputController(ctx, {
			readImage: async () => null,
			readText: async () => "api-key-123",
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		expect(focusedPasteText).toHaveBeenCalledWith("api-key-123");
		expect(spies.pasteText).not.toHaveBeenCalled();
	});

	it("reports an empty clipboard when neither image nor text is available", async () => {
		const { ctx, spies } = createContext();
		const controller = new InputController(ctx, {
			readImage: async () => null,
			readText: async () => "",
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(false);
		expect(spies.pasteText).not.toHaveBeenCalled();
		expect(spies.showStatus).toHaveBeenCalledWith("Clipboard is empty");
	});

	it("surfaces a read failure without pasting", async () => {
		const { ctx, spies } = createContext();
		const controller = new InputController(ctx, {
			readImage: async () => {
				throw new Error("clipboard unavailable");
			},
			readText: async () => "should never be used",
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(false);
		expect(spies.pasteText).not.toHaveBeenCalled();
		expect(spies.showStatus).toHaveBeenCalledWith("Failed to read clipboard");
	});
});

describe("InputController.handleClipboardTextRawPaste", () => {
	it("inserts FileDropList paths literally without reading or attaching the image", async () => {
		const { ctx, spies } = createContext();
		const readImage = vi.fn(async () => ({ data: Buffer.from("unused"), mimeType: "image/png" }));
		const readText = vi.fn(async () => "unused");
		const controller = new InputController(ctx, {
			readFilePaths: async () => ["C:\\Pictures\\one.png", "D:\\References\\two.jpg"],
			readImage,
			readText,
		});

		await controller.handleClipboardTextRawPaste();

		expect(spies.insertText).toHaveBeenCalledWith("C:\\Pictures\\one.png\nD:\\References\\two.jpg");
		expect(readText).not.toHaveBeenCalled();
		expect(readImage).not.toHaveBeenCalled();
		expect(spies.insertAtom).not.toHaveBeenCalled();
		expect(spies.putBlob).not.toHaveBeenCalled();
	});

	it("inserts clipboard text verbatim before considering an image payload", async () => {
		const { ctx, spies } = createContext();
		const readImage = vi.fn(async () => ({ data: Buffer.from("unused"), mimeType: "image/png" }));
		const controller = new InputController(ctx, {
			readFilePaths: async () => [],
			readImage,
			readText: async () => "raw $TEXT",
		});

		await controller.handleClipboardTextRawPaste();

		expect(spies.insertText).toHaveBeenCalledWith("raw $TEXT");
		expect(readImage).not.toHaveBeenCalled();
		expect(spies.showStatus).not.toHaveBeenCalled();
	});

	it("materializes a pure bitmap and inserts only its generated path", async () => {
		const { ctx, spies } = createContext();
		const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
		const controller = new InputController(ctx, {
			readFilePaths: async () => [],
			readImage: async () => ({ data: imageBytes, mimeType: "image/png" }),
			readText: async () => "",
		});

		await controller.handleClipboardTextRawPaste();

		expect(spies.putBlob).toHaveBeenCalledTimes(1);
		expect(spies.putBlob.mock.calls[0]?.[0]).toEqual(imageBytes);
		expect(spies.putBlob.mock.calls[0]?.[1]).toEqual({ extension: "png" });
		expect(spies.insertText).toHaveBeenCalledWith("C:\\omp-cache\\clipboard.png");
		expect(spies.insertAtom).not.toHaveBeenCalled();
		expect(spies.showStatus).not.toHaveBeenCalled();
	});

	it("shows the empty-clipboard status only when there is no text", async () => {
		const { ctx, spies } = createContext();
		const controller = new InputController(ctx, {
			readFilePaths: async () => [],
			readImage: async () => null,
			readText: async () => "",
		});

		await controller.handleClipboardTextRawPaste();

		expect(spies.insertText).not.toHaveBeenCalled();
		expect(spies.showStatus).toHaveBeenCalledWith("Clipboard is empty");
	});
});
