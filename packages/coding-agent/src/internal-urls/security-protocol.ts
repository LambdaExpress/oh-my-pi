import * as path from "node:path";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { isSettingsInitialized, settings } from "../config/settings";
import { getDefault } from "../config/settings-schema";
import { t } from "../i18n";
import type { SecurityFinding } from "../security/contracts";
import { createPublicSecurityScan, redactPrivateSecurityMetadata } from "../security/provenance";
import { createSecurityResource } from "../security/resource-output";
import type { SecurityScanSummary } from "../security/store";
import { SecurityStore } from "../security/store";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, UrlCompletion } from "./types";

export type SecurityStoreResolver = (cwd: string, signal?: AbortSignal) => Promise<SecurityStore>;

export function isSecurityEnabled(): boolean {
	if (!isSettingsInitialized()) return getDefault("security.enabled");
	try {
		return settings.get("security.enabled");
	} catch {
		return getDefault("security.enabled");
	}
}

function securityEnabledFromContext(context?: ResolveContext): boolean | undefined {
	if (!context?.settings || typeof context.settings !== "object") return undefined;
	try {
		const get = Reflect.get(context.settings, "get");
		if (typeof get !== "function") return undefined;
		const enabled = Reflect.apply(get, context.settings, ["security.enabled"]);
		return typeof enabled === "boolean" ? enabled : undefined;
	} catch {
		return undefined;
	}
}

export class SecurityDisabledError extends Error {
	constructor() {
		super(
			t("security:// is disabled. Enable it by setting `security.enabled = true` (Settings → Tools → Security)."),
		);
		this.name = "SecurityDisabledError";
	}
}

function splitSecurityPath(url: InternalUrl): string[] {
	const host = url.rawHost || url.hostname;
	const pathname = (url.rawPathname ?? url.pathname).replace(/^\/+/, "");
	return [host, ...pathname.split("/")].filter(Boolean).map(segment => decodeURIComponent(segment));
}

function formatScans(scans: SecurityScanSummary[]): string {
	if (scans.length === 0) return `${t("# Security scans")}\n\n${t("No scans are stored for this project.")}\n`;
	const rows = scans.map(scan =>
		t("- `{id}` — {status}; {findingCount} finding(s); {producer}; {createdAt}", {
			id: scan.id,
			status: scan.status,
			findingCount: scan.findingCount,
			producer: scan.producer.name,
			createdAt: scan.createdAt,
		}),
	);
	return `${t("# Security scans")}\n\n${rows.join("\n")}\n`;
}

function formatFinding(finding: SecurityFinding): string {
	const locations = finding.occurrences.flatMap(occurrence => occurrence.locations);
	const locationLines = locations.map(location => {
		const end = location.endLine && location.endLine !== location.startLine ? `-${location.endLine}` : "";
		return [
			`- \`${sanitizeText(location.path)}:${location.startLine}${end}\``,
			location.role ? ` (${sanitizeText(location.role)})` : "",
		].join("");
	});
	const evidence = finding.evidence.map(
		item => `- **${sanitizeText(item.label)}** — ${sanitizeText(item.explanation)}`,
	);
	return [
		`# ${sanitizeText(finding.title)}`,
		"",
		t("- ID: `{id}`", { id: finding.id }),
		t("- Rule: `{ruleId}`", { ruleId: sanitizeText(finding.ruleId) }),
		t("- Severity: **{level}**", { level: finding.severity.level }),
		t("- Confidence: **{level}**", { level: finding.confidence.level }),
		t("- Disposition: **{status}**", { status: finding.disposition.status }),
		t("- Fingerprint: `{fingerprint}`", { fingerprint: finding.fingerprint }),
		"",
		t("## Summary"),
		"",
		sanitizeText(finding.summary),
		"",
		t("## Locations"),
		"",
		...(locationLines.length > 0 ? locationLines : [t("No source locations recorded.")]),
		"",
		t("## Evidence"),
		"",
		...(evidence.length > 0 ? evidence : [t("No expanded evidence recorded.")]),
		"",
		t("## Remediation"),
		"",
		sanitizeText(finding.remediation ?? t("No remediation guidance recorded.")),
		"",
	].join("\n");
}

export class SecurityProtocolHandler implements ProtocolHandler {
	readonly scheme = "security";
	readonly immutable = true;
	readonly #resolveStore: SecurityStoreResolver;
	readonly #enabled: () => boolean;

	constructor(
		resolveStore: SecurityStoreResolver = (cwd, signal) => SecurityStore.openForCwd(cwd, { signal }),
		enabled: () => boolean = isSecurityEnabled,
	) {
		this.#resolveStore = resolveStore;
		this.#enabled = enabled;
	}

	async #store(context?: ResolveContext): Promise<SecurityStore> {
		return this.#resolveStore(path.resolve(context?.cwd ?? process.cwd()), context?.signal);
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		if (!(securityEnabledFromContext(context) ?? this.#enabled())) throw new SecurityDisabledError();
		const parts = splitSecurityPath(url);
		const store = await this.#store(context);
		if (parts.length === 0) {
			return createSecurityResource({
				url: "security://",
				content: [
					t("# Security"),
					"",
					t(
						"OMP-owned software-security analysis resources. The namespace is read-only; use explicit security commands or tools for mutations.",
					),
					"",
					t("- `security://scans` — list scans"),
					"",
				].join("\n"),
				contentType: "text/markdown",
				isDirectory: true,
			});
		}
		if (parts[0] !== "scans")
			throw new Error(t("Unknown security resource: security://{path}", { path: parts.join("/") }));
		if (parts.length === 1) {
			return createSecurityResource({
				url: "security://scans",
				content: formatScans(await store.listScans()),
				contentType: "text/markdown",
				isDirectory: true,
			});
		}
		const scanId = parts[1];
		const bundle = await store.getBundle(scanId);
		if (!bundle) throw new Error(t("Unknown security scan: {scanId}", { scanId }));
		if (parts.length === 2) {
			return createSecurityResource({
				url: `security://scans/${scanId}`,
				content: [
					t("# Security scan {scanId}", { scanId }),
					"",
					t("- Status: **{status}**", { status: bundle.scan.status }),
					t("- Producer: **{producer}**", { producer: sanitizeText(bundle.scan.producer.name) }),
					t("- Findings: **{count}**", { count: bundle.findings.length }),
					t("- Coverage: **{completeness}**", { completeness: bundle.scan.coverage.completeness }),
					t("- Target: `{target}`", { target: sanitizeText(bundle.scan.target.displayName) }),
					"",
					t("Resources: `manifest`, `findings`, `coverage`, `report`, `sarif`, `provenance`."),
					"",
				].join("\n"),
				contentType: "text/markdown",
				isDirectory: true,
			});
		}
		switch (parts[2]) {
			case "manifest":
				if (parts.length !== 3)
					throw new Error(t("Unknown security resource: security://{path}", { path: parts.join("/") }));
				return createSecurityResource({
					url: `security://scans/${scanId}/manifest`,
					content: `${JSON.stringify(createPublicSecurityScan(bundle.scan, { includePlan: true }), null, 2)}\n`,
					contentType: "application/json",
				});
			case "findings": {
				if (parts.length === 3) {
					const listing = bundle.findings.map(finding =>
						[
							t("- `{id}` **{severity}** — {title}", {
								id: finding.id,
								severity: finding.severity.level,
								title: sanitizeText(finding.title),
							}),
							t(" (`{ruleId}`)", { ruleId: sanitizeText(finding.ruleId) }),
						].join(""),
					);
					return createSecurityResource({
						url: `security://scans/${scanId}/findings`,
						content: `${t("# Findings for {scanId}", { scanId })}\n\n${
							listing.length > 0 ? listing.join("\n") : t("No findings.")
						}\n`,
						contentType: "text/markdown",
						isDirectory: true,
					});
				}
				if (parts.length !== 4)
					throw new Error(t("Unknown security resource: security://{path}", { path: parts.join("/") }));
				const findingId = parts[3];
				const finding = await store.getFinding(scanId, findingId);
				if (!finding) throw new Error(t("Unknown security finding: {findingId}", { findingId }));
				return createSecurityResource({
					url: `security://scans/${scanId}/findings/${findingId}`,
					content: formatFinding(finding),
					contentType: "text/markdown",
				});
			}
			case "coverage":
				if (parts.length !== 3)
					throw new Error(t("Unknown security resource: security://{path}", { path: parts.join("/") }));
				return createSecurityResource({
					url: `security://scans/${scanId}/coverage`,
					content: `${JSON.stringify(bundle.scan.coverage, null, 2)}\n`,
					contentType: "application/json",
				});
			case "report":
				if (parts.length !== 3)
					throw new Error(t("Unknown security resource: security://{path}", { path: parts.join("/") }));
				if (bundle.report === undefined) throw new Error(t("Security scan {scanId} has no report", { scanId }));
				return createSecurityResource({
					url: `security://scans/${scanId}/report`,
					content: bundle.report,
					contentType: "text/markdown",
				});
			case "sarif":
				if (parts.length !== 3)
					throw new Error(t("Unknown security resource: security://{path}", { path: parts.join("/") }));
				if (bundle.sarif === undefined)
					throw new Error(t("Security scan {scanId} has no SARIF export", { scanId }));
				return createSecurityResource({
					url: `security://scans/${scanId}/sarif`,
					content: `${JSON.stringify(bundle.sarif, null, 2)}\n`,
					contentType: "application/json",
				});
			case "provenance":
				if (parts.length !== 3)
					throw new Error(t("Unknown security resource: security://{path}", { path: parts.join("/") }));
				return createSecurityResource({
					url: `security://scans/${scanId}/provenance`,
					content: `${JSON.stringify(redactPrivateSecurityMetadata(bundle.scan.provenance), null, 2)}\n`,
					contentType: "application/json",
				});
			default:
				throw new Error(t("Unknown security resource: security://{path}", { path: parts.join("/") }));
		}
	}

	async complete(query = "", context?: ResolveContext): Promise<UrlCompletion[]> {
		if (!(securityEnabledFromContext(context) ?? this.#enabled())) return [];
		const store = await this.#store(context);
		const scans = await store.listScans();
		const candidates: UrlCompletion[] = [{ value: "scans", label: "Scans", description: t("Stored security scans") }];
		for (const scan of scans.slice(0, 50)) {
			const prefix = `scans/${scan.id}`;
			candidates.push({
				value: prefix,
				label: scan.id,
				description: t("{status}; {count} findings", { status: scan.status, count: scan.findingCount }),
			});
			for (const child of ["manifest", "findings", "coverage", "report", "sarif", "provenance"]) {
				candidates.push({ value: `${prefix}/${child}`, label: `${scan.id}/${child}` });
			}
		}
		const normalizedQuery = query.trim().toLowerCase();
		if (!normalizedQuery) return candidates;
		return candidates.filter(candidate =>
			[candidate.value, candidate.label ?? "", candidate.description ?? ""].some(value =>
				value.toLowerCase().includes(normalizedQuery),
			),
		);
	}
}
