/**
 * Registers the coding-agent-only tool renderers in the shared pi-tui registry.
 *
 * `adb`, `pwsh`, `ssh`, `ssh_session` and `ssh_transfer` are implemented (and
 * rendered) entirely inside coding-agent, so pi-tui cannot import them itself:
 * it only owns `toolRenderers`, the lookup `ToolExecutionComponent` and the
 * `xd://` dispatch resolve tool names against. Importing this module for its
 * side effect installs those five entries before the first render: `./index.ts`
 * does for every session, and the modules that build tool cards directly
 * (`modes/controllers/event-controller.ts`, `modes/utils/ui-helpers.ts`) do for
 * consumers that never load the tools layer.
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
