import { type Component, Container } from "@oh-my-pi/pi-tui";

export interface ToolActivityComponent {
	setToolActivityVisible(visible: boolean): void;
}

export function isToolActivityComponent(component: Component): component is Component & ToolActivityComponent {
	return typeof (component as Partial<ToolActivityComponent>).setToolActivityVisible === "function";
}

export interface ToolRowsFoldComponent {
	/** Render this tool row as its one-line activity summary (or the full card). */
	setToolRowsFolded(folded: boolean): void;
}

export function isToolRowsFoldComponent(component: Component): component is Component & ToolRowsFoldComponent {
	return typeof (component as Partial<ToolRowsFoldComponent>).setToolRowsFolded === "function";
}

export class ToolActivityContainer extends Container implements ToolActivityComponent {
	#visible = true;
	#folded = false;

	constructor(component: Component | Component[]) {
		super();
		if (Array.isArray(component)) {
			for (const child of component) this.addChild(child);
		} else {
			this.addChild(component);
		}
	}

	setToolActivityVisible(visible: boolean): void {
		if (this.#visible === visible) return;
		this.#visible = visible;
		this.invalidate();
	}

	setToolRowsFolded(folded: boolean): void {
		if (this.#folded === folded) return;
		this.#folded = folded;
		for (const child of this.children) {
			if (isToolRowsFoldComponent(child)) child.setToolRowsFolded(folded);
		}
		this.invalidate();
	}

	/**
	 * Forward Ctrl+O expansion to wrapped children. The transcript's expansion
	 * traversal only visits top-level children, so the wrapper must proxy or
	 * wrapped renderers would freeze at their insertion-time expansion state.
	 */
	setExpanded(expanded: boolean): void {
		for (const child of this.children) {
			const expandable = child as Partial<{ setExpanded(expanded: boolean): void }>;
			if (typeof expandable.setExpanded === "function") expandable.setExpanded(expanded);
		}
	}

	override render(width: number): readonly string[] {
		if (!this.#visible) return [];
		return super.render(width);
	}
}
