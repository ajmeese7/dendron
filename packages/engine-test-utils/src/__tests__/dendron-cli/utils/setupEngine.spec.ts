import { setupEngine } from "@dendronhq/dendron-cli";
import { createEngineFromServer, runEngineTestV5 } from "../../..";

const createEngine = createEngineFromServer;

describe("GIVEN setupEngine", () => {
  describe("WHEN --attach option", () => {
    test("THEN attach to running engine", (done) => {
      jest.setTimeout(15000);
      runEngineTestV5(
        async ({ wsRoot, engine, port }) => {
          const resp = await setupEngine({
            wsRoot,
            noWritePort: true,
            attach: true,
            target: "cli",
          });
          expect(resp.engine.notes).toEqual(engine.notes);
          expect(resp.port).toEqual(port);
          resp.server.close(() => {
            done();
          });
        },
        {
          expect,
          createEngine,
        }
      );
    });
  });
});