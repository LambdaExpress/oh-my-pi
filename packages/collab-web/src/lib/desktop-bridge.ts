export interface DesktopProject {
	path: string;
	name: string;
	current: boolean;
}

export interface DesktopBridge {
	/** True when a Tauri invoke bridge is present, independent of project-command authorization. */
	runtime: boolean;
	available: boolean;
	listProjects(): Promise<readonly DesktopProject[]>;
	openProject(): Promise<void>;
	switchProject(path: string): Promise<void>;
	windowMinimize(): Promise<void>;
	windowToggleMaximize(): Promise<boolean>;
	windowIsMaximized(): Promise<boolean>;
	windowStartDragging(): Promise<void>;
	windowClose(): Promise<void>;
}

interface ProjectListResponse {
	recent_projects: string[];
	last_project: string | null;
	current_project: string | null;
}

export type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface TauriWindow extends Window {
	__TAURI_INTERNALS__?: {
		invoke?: TauriInvoke;
	};
}

function getTauriInvoke(): TauriInvoke | null {
	if (typeof window === "undefined") return null;
	const invoke = (window as TauriWindow).__TAURI_INTERNALS__?.invoke;
	return typeof invoke === "function" ? invoke : null;
}

function comparablePath(path: string): string {
	const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
	return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//") ? normalized.toLocaleLowerCase() : normalized;
}

function basename(path: string): string {
	const withoutTrailingSeparators = path.replace(/[\\/]+$/, "");
	return withoutTrailingSeparators.split(/[\\/]/).pop() || path;
}

function browserBridge(): DesktopBridge {
	return {
		runtime: false,
		available: false,
		async listProjects() {
			return [];
		},
		async openProject() {},
		async switchProject(_path: string) {},
		async windowMinimize() {},
		async windowToggleMaximize() {
			return false;
		},
		async windowIsMaximized() {
			return false;
		},
		async windowStartDragging() {},
		async windowClose() {},
	};
}

function tauriBridge(invoke: TauriInvoke): DesktopBridge {
	let authorization: "unknown" | "authorized" | "denied" = "unknown";

	return {
		runtime: true,
		get available() {
			return authorization === "authorized";
		},
		async listProjects() {
			if (authorization === "denied") return [];
			try {
				const list = await invoke<ProjectListResponse>("project_list");
				authorization = "authorized";
				const current = list.current_project === null ? null : comparablePath(list.current_project);
				const projects = list.recent_projects.map(path => ({
					path,
					name: basename(path),
					current: current !== null && comparablePath(path) === current,
				}));
				if (list.current_project !== null && !projects.some(project => project.current)) {
					projects.unshift({
						path: list.current_project,
						name: basename(list.current_project),
						current: true,
					});
				}
				return projects;
			} catch {
				authorization = "denied";
				return [];
			}
		},
		async openProject() {
			if (authorization !== "authorized") return;
			try {
				await invoke<void>("project_open");
			} catch (error) {
				authorization = "denied";
				throw error;
			}
		},
		async switchProject(path: string) {
			if (authorization !== "authorized") return;
			try {
				await invoke<void>("project_switch", { path });
			} catch (error) {
				authorization = "denied";
				throw error;
			}
		},
		async windowMinimize() {
			await invoke<void>("window_minimize");
		},
		async windowToggleMaximize() {
			return await invoke<boolean>("window_toggle_maximize");
		},
		async windowIsMaximized() {
			return await invoke<boolean>("window_is_maximized");
		},
		async windowStartDragging() {
			await invoke<void>("window_start_dragging");
		},
		async windowClose() {
			await invoke<void>("window_close");
		},
	};
}

/** Creates an isolated bridge so capability probing can be exercised without a Tauri runtime. */
export function createDesktopBridge(invoke: TauriInvoke | null = getTauriInvoke()): DesktopBridge {
	return invoke === null ? browserBridge() : tauriBridge(invoke);
}

export const desktopBridge: DesktopBridge = createDesktopBridge();
