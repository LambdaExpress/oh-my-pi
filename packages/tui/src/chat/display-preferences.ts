/** Process-wide display preferences applied by the host settings hooks. */
export interface ChatTranscriptDisplayPreferences {
	hideToolActivity: boolean;
	readToolResultPreview: boolean;
	showImages: boolean;
	cacheMissMarker: boolean;
	/**
	 * Collapse every activity row — tool calls, TTSR injections, todo reminders,
	 * late diagnostics — into its one-line summary. Local feature.
	 */
	foldToolRows: boolean;
	showTokenUsage: boolean;
	showTurnTime: boolean;
}

/** Current transcript display preferences. */
export const chatTranscriptDisplayPreferences: ChatTranscriptDisplayPreferences = {
	hideToolActivity: false,
	readToolResultPreview: false,
	showImages: true,
	cacheMissMarker: false,
	foldToolRows: false,
	showTokenUsage: false,
	showTurnTime: false,
};

/** Apply host display preferences without pulling settings into the renderer. */
export function setChatTranscriptDisplayPreferences(preferences: Partial<ChatTranscriptDisplayPreferences>): void {
	Object.assign(chatTranscriptDisplayPreferences, preferences);
}
