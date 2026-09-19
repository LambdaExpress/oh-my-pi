/**
 * Registers the coding-agent-only tool renderers in the shared pi-tui registry.
 *
 * `adb`, `pwsh`, `ssh`, `ssh_session` and `ssh_transfer` are implemented (and
 * rendered) entirely inside coding-agent, so pi-tui cannot import them itself:
 * it only owns `toolRenderers`, the lookup `ToolExecutionComponent` and the
 * `xd://` dispatch resolve tool names against. Importing this module for its
 * side effect — `./index.ts` does, and every session that can render a tool
 * goes through it — installs those five entries before the first render.
 */
import { toolRenderers } from "@oh-my-pi/pi-tui/tools";
import { adbToolRenderer } from "./adb";
import { pwshToolRenderer } from "./pwsh";
import { sshToolRenderer } from "./ssh";
import { sshSessionToolRenderer } from "./ssh-session";
import { sshTransferToolRenderer } from "./ssh-transfer";

toolRenderers.adb = adbToolRenderer;
toolRenderers.pwsh = pwshToolRenderer;
toolRenderers.ssh = sshToolRenderer;
toolRenderers.ssh_session = sshSessionToolRenderer;
toolRenderers.ssh_transfer = sshTransferToolRenderer;
