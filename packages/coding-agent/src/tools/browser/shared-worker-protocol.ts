/** Hidden CLI selector used to supervise a broker-owned shared Chromium. */
export const SHARED_BROWSER_WORKER_ARG = "__omp_worker_browser_shared";

/** Environment key carrying the resolved Chromium launch configuration. */
export const SHARED_BROWSER_WORKER_CONFIG_ENV = "OMP_SHARED_BROWSER_WORKER_CONFIG";

/** Parent-to-worker launch contract. */
export interface SharedBrowserWorkerConfig {
	executablePath: string;
	args: string[];
	cwd: string;
	userDataDir: string;
	headless: boolean;
}
