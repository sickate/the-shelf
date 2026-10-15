import { WorkflowEntrypoint } from "cloudflare:workers";
import { cryptoProbe } from "./crypto.mjs";
import { handle } from "./handler.mjs";
import { runWorkflow } from "./core.mjs";

export class Cf01Workflow extends WorkflowEntrypoint {
  async run(event, step) { return runWorkflow(this.env, event.payload, step); }
}
export default { fetch: (request, env) => handle(request, env, cryptoProbe) };
