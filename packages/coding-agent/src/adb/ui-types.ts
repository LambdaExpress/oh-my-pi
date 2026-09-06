export interface AdbUiBounds {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export interface AdbUiElement {
	ref: string;
	parentIndex?: number;
	depth: number;
	text: string;
	resourceId: string;
	description: string;
	className: string;
	packageName: string;
	bounds: AdbUiBounds;
	visible: boolean;
	enabled: boolean;
	clickable: boolean;
	longClickable: boolean;
	scrollable: boolean;
	checkable: boolean;
	checked: boolean;
	focusable: boolean;
	focused: boolean;
	selected: boolean;
	password: boolean;
}

export interface AdbUiSelector {
	text?: string;
	textContains?: string;
	resourceId?: string;
	description?: string;
	className?: string;
	packageName?: string;
	enabled?: boolean;
	checked?: boolean;
	focused?: boolean;
	selected?: boolean;
}

export type AdbUiTarget = AdbUiSelector | { ref: string };
export type AdbUiWaitUntil = "visible" | "hidden" | "enabled" | "disabled";

export interface AdbUiHierarchy {
	rotation: number;
	elements: AdbUiElement[];
}

export interface AdbUiObservation extends AdbUiHierarchy {
	serial: string;
	snapshot: string;
}

export interface AdbUiClickResult {
	element: AdbUiElement;
	x: number;
	y: number;
}

export interface AdbUiWaitResult {
	observation: AdbUiObservation;
	matches: AdbUiElement[];
	until: AdbUiWaitUntil;
}
