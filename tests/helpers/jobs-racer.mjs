// Isolated Node worker used only against a temporary synthetic SQLite database.
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { createJobsState } from "../../cloudflare/library/jobs-state.mjs";
import { SqlD1, id } from "./jobs-fixture.mjs";
const sql = new DatabaseSync(workerData.file);
sql.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
const db = new SqlD1(sql),
  gate = new Int32Array(workerData.gate);
const barrier = () => {
  parentPort.postMessage({ ready: true });
  Atomics.wait(gate, 0, 0, 10000);
};
try {
  if (workerData.kind === "filename") {
    barrier();
    sql
      .prepare(
        "INSERT INTO filename_identifications VALUES('production',?,?,'filename-v1',?,1,?,?,?,1,'pending',NULL,NULL,NULL,?)",
      )
      .run(
        id(9999),
        "e".repeat(64),
        workerData.grant.sessionHash,
        workerData.now,
        workerData.now + 60000,
        Math.floor(workerData.now / 86400000),
        workerData.now,
      );
    parentPort.postMessage({ winner: true });
  } else {
    db.beforeBatch = barrier;
    const state = createJobsState(db, { clock: () => workerData.now });
    const result = await state.admitJob(workerData.input, workerData.grant);
    parentPort.postMessage({
      winner: result.permit !== null,
      jobId: result.job.id,
    });
  }
} catch {
  parentPort.postMessage({ winner: false });
} finally {
  sql.close();
}
