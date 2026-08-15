import { type } from "@oh-my-pi/omptype";
import { t } from "../../i18n";
import { getSecurityContractSchemas } from "./schemas";
import type { SecurityFinding, SecurityScan, SecurityScanBundle, SecurityScanPlan } from "./types";

function schemaError(label: string, errors: type.errors): Error {
	return new Error(t("{label} failed schema validation: {summary}", { label, summary: errors.summary }));
}

export function parseSecurityFinding(value: unknown): SecurityFinding {
	const { securityFindingSchema } = getSecurityContractSchemas();
	const result = securityFindingSchema(value);
	if (result instanceof type.errors) throw schemaError(t("Security finding"), result);
	return result as SecurityFinding;
}

export function parseSecurityScan(value: unknown): SecurityScan {
	const { securityScanSchema } = getSecurityContractSchemas();
	const result = securityScanSchema(value);
	if (result instanceof type.errors) throw schemaError(t("Security scan"), result);
	return result as SecurityScan;
}

export function parseSecurityScanPlan(value: unknown): SecurityScanPlan {
	const { securityScanPlanSchema } = getSecurityContractSchemas();
	const result = securityScanPlanSchema(value);
	if (result instanceof type.errors) throw schemaError(t("Security scan plan"), result);
	return result as SecurityScanPlan;
}

export function parseSecurityScanBundle(value: unknown): SecurityScanBundle {
	const { securityScanBundleSchema } = getSecurityContractSchemas();
	const result = securityScanBundleSchema(value);
	if (result instanceof type.errors) throw schemaError(t("Security scan bundle"), result);
	const bundle = result as SecurityScanBundle;
	const findingIds = new Set(bundle.findings.map(finding => finding.id));
	if (findingIds.size !== bundle.findings.length) throw new Error(t("Security scan contains duplicate finding ids"));
	const referencedFindingIds = new Set(bundle.scan.findingIds);
	if (referencedFindingIds.size !== bundle.scan.findingIds.length) {
		throw new Error(t("Security scan manifest contains duplicate finding references"));
	}
	for (const findingId of referencedFindingIds) {
		if (!findingIds.has(findingId))
			throw new Error(t("Security scan references missing finding: {findingId}", { findingId }));
	}
	for (const findingId of findingIds) {
		if (!referencedFindingIds.has(findingId))
			throw new Error(t("Security scan omits finding from manifest: {findingId}", { findingId }));
	}
	for (const finding of bundle.findings) {
		if (finding.scanId !== bundle.scan.id) {
			throw new Error(
				t("Finding {id} belongs to {scanId}, expected {expected}", {
					id: finding.id,
					scanId: finding.scanId,
					expected: bundle.scan.id,
				}),
			);
		}
		const evidenceIds = new Set(finding.evidence.map(evidence => evidence.id));
		if (evidenceIds.size !== finding.evidence.length) {
			throw new Error(t("Finding {id} contains duplicate evidence ids", { id: finding.id }));
		}
		const occurrenceIds = new Set(finding.occurrences.map(occurrence => occurrence.id));
		if (occurrenceIds.size !== finding.occurrences.length) {
			throw new Error(t("Finding {id} contains duplicate occurrence ids", { id: finding.id }));
		}
		for (const occurrence of finding.occurrences) {
			for (const evidenceId of occurrence.evidenceIds) {
				if (!evidenceIds.has(evidenceId)) {
					throw new Error(
						t("Occurrence {id} references missing evidence: {evidenceId}", {
							id: occurrence.id,
							evidenceId,
						}),
					);
				}
			}
		}
	}
	return bundle;
}
