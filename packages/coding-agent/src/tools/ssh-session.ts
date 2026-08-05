import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { prompt } from "@oh-my-pi/pi-utils";
import type { SSHHostConfig } from "../capability/ssh";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import sshSessionDescription from "../prompts/tools/ssh-session.md" with { type: "text" };
import { validateHostName } from "../ssh/config-writer";
import { Ellipsis, renderStatusLine, truncateToWidth } from "../tui";
import type { ToolSession } from ".";
import { replaceTabs } from "./render-utils";
import { ToolError } from "./tool-errors";

const sshSessionSchema = type({
	op: "'create' | 'update' | 'delete' | 'list'",
	"name?": type("string").describe("session SSH alias for create, update, or delete"),
	"host?": type("string").describe("SSH host address; required for create"),
	"username?": type("string | null").describe("SSH username; null clears it during update"),
	"key_path?": type("string | null").describe("local private-key path; null clears it during update"),
	"password?": type("string | null").describe("literal password; null clears it during update"),
	"description?": type("string | null").describe("alias description; null clears it during update"),
	"port?": type("number | null").describe("SSH port from 1 through 65535; null clears it during update"),
	"compat?": type("boolean | null").describe("compatibility mode; null clears it during update"),
});

export type SshSessionParams = typeof sshSessionSchema.infer;

const MUTABLE_FIELDS = ["host", "username", "key_path", "password", "description", "port", "compat"] as const;
type MutableField = (typeof MUTABLE_FIELDS)[number];

export interface SshSessionHostView {
	name: string;
	host: string;
	username?: string;
	port?: number;
	keyPath?: string;
	description?: string;
	compat?: boolean;
	hasPassword: boolean;
}

export interface SshSessionToolDetails {
	op: SshSessionParams["op"];
	host?: SshSessionHostView;
	hosts?: SshSessionHostView[];
	changedFields?: string[];
}

function hasField(params: SshSessionParams, field: MutableField): boolean {
	return Object.hasOwn(params, field) && params[field] !== undefined;
}

function requireName(params: SshSessionParams): string {
	if (typeof params.name !== "string") throw new ToolError(`"name" is required for "${params.op}"`);
	const error = validateHostName(params.name);
	if (error) throw new ToolError(error);
	return params.name;
}

function requireNonEmptyString(value: string, field: string, preserveWhitespace = false): string {
	if (value.trim().length === 0) throw new ToolError(`"${field}" cannot be empty`);
	return preserveWhitespace ? value : value.trim();
}

function validatePort(port: number | null | undefined): void {
	if (port === null || port === undefined) return;
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new ToolError('"port" must be an integer from 1 through 65535');
	}
}

function rejectMutableFields(params: SshSessionParams): void {
	const unexpected = MUTABLE_FIELDS.filter(field => hasField(params, field));
	if (unexpected.length > 0) {
		throw new ToolError(`"${params.op}" does not accept: ${unexpected.join(", ")}`);
	}
}

function normalizeConfig(params: SshSessionParams, base?: SSHHostConfig): SSHHostConfig {
	const config: SSHHostConfig = base ? structuredClone(base) : { host: "" };
	if (hasField(params, "host")) config.host = requireNonEmptyString(params.host!, "host");
	if (!config.host) throw new ToolError('"host" is required for "create"');

	for (const [inputField, configField] of [
		["username", "username"],
		["key_path", "keyPath"],
		["password", "password"],
		["description", "description"],
	] as const) {
		if (!hasField(params, inputField)) continue;
		const value = params[inputField];
		if (value === undefined) continue;
		if (value === null) {
			delete config[configField];
		} else {
			config[configField] = requireNonEmptyString(value, inputField, inputField === "password");
		}
	}

	if (hasField(params, "port")) {
		const port = params.port;
		validatePort(port);
		if (port === null) delete config.port;
		else if (port !== undefined) config.port = port;
	}
	if (hasField(params, "compat")) {
		const compat = params.compat;
		if (compat === null) delete config.compat;
		else if (compat !== undefined) config.compat = compat;
	}
	return config;
}

function hostView(name: string, config: SSHHostConfig): SshSessionHostView {
	return {
		name,
		host: config.host,
		...(config.username === undefined ? {} : { username: config.username }),
		...(config.port === undefined ? {} : { port: config.port }),
		...(config.keyPath === undefined ? {} : { keyPath: config.keyPath }),
		...(config.description === undefined ? {} : { description: config.description }),
		...(config.compat === undefined ? {} : { compat: config.compat }),
		hasPassword: config.password !== undefined,
	};
}

function formatHost(view: SshSessionHostView): string {
	const target = `${view.username ? `${view.username}@` : ""}${view.host}${view.port ? `:${view.port}` : ""}`;
	return `${view.name}: ${target}${view.hasPassword ? " (password configured)" : ""}`;
}

function formatSafeArgumentLines(params: Partial<SshSessionParams>): string[] {
	const lines = [`Operation: ${typeof params.op === "string" ? params.op : "(missing)"}`];
	if (typeof params.name === "string") lines.push(`Name: ${params.name}`);
	for (const [field, value] of [
		["host", params.host],
		["username", params.username],
		["key_path", params.key_path],
		["description", params.description],
		["port", params.port],
		["compat", params.compat],
	] as const) {
		if (value !== undefined) lines.push(`${field}: ${value === null ? "(clear)" : String(value)}`);
	}
	if (params.password !== undefined || params.op === "create") {
		lines.push(`hasPassword: ${typeof params.password === "string"}`);
	}
	return lines;
}

export class SshSessionTool implements AgentTool<typeof sshSessionSchema, SshSessionToolDetails> {
	readonly name = "ssh_session";
	readonly approval = "write" as const;
	readonly label = "SSH Session";
	readonly summary = "Manage SSH aliases for the current session";
	readonly description = prompt.render(sshSessionDescription);
	readonly parameters = sshSessionSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly concurrency = "exclusive" as const;
	readonly formatApprovalDetails = (args: unknown): string[] =>
		formatSafeArgumentLines(args as Partial<SshSessionParams>);

	constructor(private readonly session: ToolSession) {}

	async execute(_toolCallId: string, params: SshSessionParams): Promise<AgentToolResult<SshSessionToolDetails>> {
		const getHosts = this.session.getSessionSshConfigs;
		const mutate = this.session.mutateSessionSshConfig;
		if (!getHosts || !mutate) throw new ToolError("Session SSH configuration is unavailable");
		const hosts = getHosts();

		switch (params.op) {
			case "list": {
				if (params.name !== undefined) throw new ToolError('"list" does not accept "name"');
				rejectMutableFields(params);
				const views = [...hosts]
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([name, value]) => hostView(name, value.config));
				return {
					content: [
						{ type: "text", text: views.length > 0 ? views.map(formatHost).join("\n") : "No session SSH hosts." },
					],
					details: { op: params.op, hosts: views },
				};
			}
			case "create": {
				const name = requireName(params);
				if (hosts.has(name)) throw new ToolError(`Session SSH host "${name}" already exists`);
				for (const field of MUTABLE_FIELDS) {
					if (hasField(params, field) && params[field] === null) {
						throw new ToolError(`"${field}" cannot be null for "create"`);
					}
				}
				validatePort(params.port);
				const config = normalizeConfig(params);
				await mutate({ operation: "upsert", name, config });
				const view = hostView(name, config);
				const changedFields = MUTABLE_FIELDS.filter(field => hasField(params, field));
				return {
					content: [{ type: "text", text: `Created session SSH host ${formatHost(view)}.` }],
					details: { op: params.op, host: view, changedFields },
				};
			}
			case "update": {
				const name = requireName(params);
				const existing = hosts.get(name);
				if (!existing) throw new ToolError(`Session SSH host "${name}" not found`);
				const changedFields = MUTABLE_FIELDS.filter(field => hasField(params, field));
				if (changedFields.length === 0) throw new ToolError('"update" requires at least one configurable field');
				validatePort(params.port);
				const config = normalizeConfig(params, existing.config);
				await mutate({ operation: "upsert", name, config });
				const view = hostView(name, config);
				return {
					content: [
						{ type: "text", text: `Updated session SSH host ${formatHost(view)} (${changedFields.join(", ")}).` },
					],
					details: { op: params.op, host: view, changedFields },
				};
			}
			case "delete": {
				const name = requireName(params);
				rejectMutableFields(params);
				const existing = hosts.get(name);
				if (!existing) throw new ToolError(`Session SSH host "${name}" not found`);
				const view = hostView(name, existing.config);
				await mutate({ operation: "delete", name });
				return {
					content: [{ type: "text", text: `Deleted session SSH host "${name}".` }],
					details: { op: params.op, host: view },
				};
			}
		}
	}
}

export const sshSessionToolRenderer = {
	mergeCallAndResult: true,

	renderCall(args: Partial<SshSessionParams>, _options: RenderResultOptions, uiTheme: Theme): Component {
		const op = typeof args.op === "string" ? args.op : "…";
		const name = typeof args.name === "string" ? replaceTabs(args.name) : undefined;
		const fields = formatSafeArgumentLines(args)
			.slice(name ? 2 : 1)
			.map(line => uiTheme.fg("muted", truncateToWidth(replaceTabs(line), 72, Ellipsis.Omit)));
		const text = renderStatusLine(
			{
				icon: "pending",
				title: "SSH Session",
				description: name ? `${op} ${name}` : op,
				meta: fields.length > 0 ? fields : undefined,
			},
			uiTheme,
		);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: SshSessionToolDetails; isError?: boolean },
		_options: RenderResultOptions,
		uiTheme: Theme,
	): Component {
		const details = result.details;
		const op = details?.op ?? "operation";
		const description = result.isError
			? "failed"
			: details?.hosts
				? `${details.hosts.length} host${details.hosts.length === 1 ? "" : "s"}`
				: details?.host
					? formatHost(details.host)
					: op;
		const meta = details?.changedFields?.map(field =>
			uiTheme.fg("muted", field === "password" ? `hasPassword: ${details.host?.hasPassword === true}` : field),
		);
		const text = renderStatusLine(
			{
				icon: result.isError ? "error" : "success",
				title: "SSH Session",
				description: truncateToWidth(replaceTabs(description), 80, Ellipsis.Omit),
				meta: meta && meta.length > 0 ? meta : undefined,
			},
			uiTheme,
		);
		return new Text(text, 0, 0);
	},
};
