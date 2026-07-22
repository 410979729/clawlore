import { diagnosticErrorSummary } from "../diagnostic-redaction.js";
import { resolvePrincipalWriteTarget } from "../principal-write-boundary.js";
import {
  type CliRegistrationContext,
  writeJson,
} from "./cli-runtime-policy.js";

export function registerPrincipalCommands(runtime: CliRegistrationContext): void {
  const principal = runtime.memory
    .command("principal")
    .description("Resolve the versioned principal boundary used by every out-of-band memory writer");

  principal
    .command("resolve")
    .description("Resolve one exact principal or OpenClaw session key to its durable write scope")
    .option("--principal-key <platform:account:principal>", "Exact canonical private principal")
    .option("--session-key <key>", "Exact OpenClaw session key")
    .option("--allow-conversation", "Permit an explicitly identified group/channel conversation scope")
    .option("--json", "Output as JSON")
    .action((options) => {
      try {
        const result = resolvePrincipalWriteTarget({
          principalKey: options.principalKey,
          sessionKey: options.sessionKey,
          allowConversation: options.allowConversation === true,
        });
        if (options.json) {
          writeJson(result);
          return;
        }
        console.log(`Contract: ${result.contract}`);
        console.log(`Boundary: ${result.kind}`);
        console.log(`Scope: ${result.scope}`);
        if (result.principalHash) console.log(`Principal hash: ${result.principalHash}`);
        if (result.conversationHash) console.log(`Conversation hash: ${result.conversationHash}`);
      } catch (error) {
        console.error(`Principal resolution failed: ${diagnosticErrorSummary(error)}`);
        process.exitCode = 1;
      }
    });
}
