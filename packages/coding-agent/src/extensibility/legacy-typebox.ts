import { type } from "@oh-my-pi/omptype";
import {
	type AnySchema,
	type ObjectOpts,
	Type as OmpType,
	type TypeBuilder as OmpTypeBuilder,
	type TUnsafe,
} from "@oh-my-pi/omptype/typebox";
import { upgradeJsonSchemaTo202012, validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema";

export * from "@oh-my-pi/omptype/typebox";

const VALIDATION_FAILURE = Symbol("pi.typebox.validationFailure");

interface ValidationFailure {
	message: string;
	readonly [VALIDATION_FAILURE]: true;
}

interface SafeParseSuccess<T> {
	success: true;
	data: T;
}

interface SafeParseFailure {
	success: false;
	error: ValidationFailure;
}

type LegacyUnsafeSchema<T> = TUnsafe<T> & {
	__validator(data: unknown): T | ValidationFailure;
	safeParse(input: unknown): SafeParseSuccess<T> | SafeParseFailure;
};

function isValidationFailure<T>(result: T | ValidationFailure): result is ValidationFailure {
	return typeof result === "object" && result !== null && VALIDATION_FAILURE in result;
}

function isRuntimeSchema(value: unknown): value is AnySchema {
	return typeof value === "function";
}

function defineHidden(target: object, key: PropertyKey, value: unknown): void {
	Object.defineProperty(target, key, {
		value,
		writable: true,
		configurable: true,
	});
}

function unsafe<T = unknown>(jsonSchema: Record<string, unknown> = {}): LegacyUnsafeSchema<T> {
	// `document` is the verbatim wire schema; keep it isolated from the validator.
	// `upgradeJsonSchemaTo202012` returns its input untouched when no upgrade is
	// needed, and `validateJsonSchemaValue` then annotates that object with JIT
	// epoch metadata and normalized keywords — which would leak into emission if
	// the two shared a reference.
	const document = structuredClone(jsonSchema);
	const upgradedSchema = upgradeJsonSchemaTo202012(structuredClone(jsonSchema));
	const validate = (data: unknown): T | ValidationFailure => {
		const result = validateJsonSchemaValue(upgradedSchema, data);
		if (result.success) return data as T;
		let message = "";
		for (const issue of result.issues) {
			if (message) message += "; ";
			message += issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
		}
		const failure = { message: message || "Invalid value" } as ValidationFailure;
		defineHidden(failure, VALIDATION_FAILURE, true);
		return failure;
	};
	// Validate through the authoritative JSON Schema validator, not
	// `fromJsonSchema`: lowering `additionalProperties: false` while dropping the
	// keywords it cannot model (e.g. `patternProperties`) would reject values the
	// raw document accepts. `type.withJsonSchema` then emits the raw document
	// verbatim so nested composition (`Type.Object`, `Type.Optional`) keeps every
	// keyword in the wire schema, not just at the top level.
	const runtime = type.unknown.narrow((data, ctx) => {
		const result = validate(data);
		return isValidationFailure(result) ? ctx.mustBe(result.message) : true;
	});
	const schema = type.withJsonSchema(runtime, document) as unknown as LegacyUnsafeSchema<T>;
	defineHidden(schema, "__validator", validate);
	defineHidden(schema, "safeParse", (input: unknown): SafeParseSuccess<T> | SafeParseFailure => {
		const result = validate(input);
		return isValidationFailure(result) ? { success: false, error: result } : { success: true, data: result };
	});
	return schema;
}

const object = ((properties: Record<string, unknown>, opts?: ObjectOpts) => {
	let normalizedOpts = opts;
	const additionalProperties: unknown = opts?.additionalProperties;
	if (
		additionalProperties !== undefined &&
		typeof additionalProperties !== "boolean" &&
		!isRuntimeSchema(additionalProperties)
	) {
		normalizedOpts = {
			...opts,
			additionalProperties: unsafe(additionalProperties as Record<string, unknown>),
		};
	}

	let hasRawProperty = false;
	for (const key in properties) {
		if (!isRuntimeSchema(properties[key])) {
			hasRawProperty = true;
			break;
		}
	}
	if (!hasRawProperty) {
		return OmpType.Object(properties as Record<string, AnySchema>, normalizedOpts);
	}

	const normalizedProperties: Record<string, AnySchema> = {};
	for (const key in properties) {
		const property = properties[key];
		normalizedProperties[key] = isRuntimeSchema(property) ? property : unsafe(property as Record<string, unknown>);
	}
	if (additionalProperties !== undefined && typeof additionalProperties !== "boolean") {
		// omptype index signatures validate every string key, including declared
		// properties. JSON Schema `additionalProperties` validates only undeclared
		// keys, so preserve the whole document on this legacy raw-property path.
		const { additionalProperties: _, ...objectOpts } = opts ?? {};
		const document = OmpType.Object(normalizedProperties, objectOpts).toJsonSchema();
		document.additionalProperties = isRuntimeSchema(additionalProperties)
			? additionalProperties.toJsonSchema()
			: structuredClone(additionalProperties);
		return unsafe(document);
	}
	return OmpType.Object(normalizedProperties, normalizedOpts);
}) as typeof OmpType.Object;

export const Type = { ...OmpType, Object: object, Unsafe: unsafe } as unknown as OmpTypeBuilder;
export type TypeBuilder = OmpTypeBuilder;

const legacyTypeBox: { Type: OmpTypeBuilder } = { Type };
export default legacyTypeBox;
