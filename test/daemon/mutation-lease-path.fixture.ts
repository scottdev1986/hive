import { tmpdir } from "node:os";
import { getMachineMutationDatabasePath } from "../../src/daemon/mutation-lease";

process.stdout.write(
  JSON.stringify({
    tmpdir: tmpdir(),
    databasePath: getMachineMutationDatabasePath(),
  }),
);
