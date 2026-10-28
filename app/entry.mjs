// Worker entry (wrangler main): the HTTP handler from worker.mjs plus the read-aloud Workflow class.
// Kept separate so the Node tests can import worker.mjs without the workerd-only "cloudflare:workers".
import { WorkflowEntrypoint } from "cloudflare:workers";
import worker, { runAudioWorkflow } from "./worker.mjs";

export class AudioWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    return runAudioWorkflow(this.env, event, step);
  }
}

export default worker;
