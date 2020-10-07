import { DEngineV2, NoteUtilsV2, SchemaUtilsV2 } from "@dendronhq/common-all";
import { createLogger, note2File } from "@dendronhq/common-server";
import {
  EngineTestUtilsV2,
  NodeTestUtilsV2,
} from "@dendronhq/common-test-utils";
import fs from "fs-extra";
import path from "path";
import { FileStorageV2 } from "../drivers/file/storev2";
import { DendronEngineV2 } from "../enginev2";

let LOGGER = createLogger("enginev2.spec", "/tmp/engine-server.log");

const beforePreset = async () => {
  const vaultDir = await EngineTestUtilsV2.setupVault({
    initDirCb: async (vaultPath: string) => {
      await NodeTestUtilsV2.createSchemas({ vaultPath });
      await NodeTestUtilsV2.createNotes({ vaultPath });
      await NodeTestUtilsV2.createNoteProps({ vaultPath, rootName: "foo" });
      await NodeTestUtilsV2.createSchemaModuleOpts({
        vaultDir: vaultPath,
        rootName: "foo",
      });
    },
  });
  const engine = new DendronEngineV2({
    vaults: [vaultDir],
    forceNew: true,
    store: new FileStorageV2({ vaults: [vaultDir], logger: LOGGER }),
    mode: "fuzzy",
    logger: LOGGER,
  });
  return { vaultDir, engine };
};

describe("matchPath", () => {
  let engine: DEngineV2;

  beforeEach(async () => {
    ({ engine } = await beforePreset());
  });

  it("match path on domain, reg", async () => {
    await engine.init();
    const resp = SchemaUtilsV2.matchPath({
      notePath: "foo",
      schemaModDict: engine.schemas,
    });
    expect(resp?.schema.id).toEqual("foo");
  });

  it("match path on domain as namespace", async () => {
    await engine.init();
    const schema = SchemaUtilsV2.createModuleProps({ fname: "bond" });
    schema.schemas[schema.root.id].data.namespace = true;
    await engine.init();
    await engine.updateSchema(schema);
    const resp = SchemaUtilsV2.matchPath({
      notePath: "bond",
      schemaModDict: engine.schemas,
    });
    expect(resp?.schema.id).toEqual("bond");
  });

  it("match path on domain as namespace, child", async () => {
    await engine.init();
    const schema = SchemaUtilsV2.createModuleProps({ fname: "bond" });
    schema.schemas[schema.root.id].data.namespace = true;
    await engine.init();
    await engine.updateSchema(schema);
    const resp = SchemaUtilsV2.matchPath({
      notePath: "bond.foo",
      schemaModDict: engine.schemas,
    });
    expect(resp?.schema.id).toEqual("bond");
  });
});

describe("matchDomain", () => {
  let vaultDir: string;
  let engine: DEngineV2;

  beforeEach(async () => {
    ({ vaultDir, engine } = await beforePreset());
  });

  it("match path on domain, reg", async () => {
    await engine.init();
    const schema = engine.notes["foo"].schema;
    expect(schema).toMatchSnapshot();
    expect(schema).toEqual({ moduleId: "foo", schemaId: "foo" });
  });

  it("match path on domain as namespace", async () => {
    await NodeTestUtilsV2.createSchemaModuleOpts({
      vaultDir,
      rootName: "bond",
      rootOpts: {
        data: { namespace: true },
      },
    });
    await NodeTestUtilsV2.createNoteProps({
      vaultPath: vaultDir,
      rootName: "bond",
    });
    fs.removeSync(path.join(vaultDir, "foo.schema.yml"));
    await engine.init();
    const schema = engine.notes["bond"].schema;
    expect(schema).toMatchSnapshot();
    expect(schema).toEqual({ moduleId: "bond", schemaId: "bond" });
  });

  it("match path on domain as namespace", async () => {
    await NodeTestUtilsV2.createSchemaModuleOpts({
      vaultDir,
      rootName: "bond",
      rootOpts: {
        data: { namespace: true },
      },
    });
    const rootName = "bond";
    const ch1 = NoteUtilsV2.create({
      fname: `${rootName}.ch1`,
      id: `${rootName}.ch1`,
      created: "1",
      updated: "1",
    });
    await note2File(ch1, vaultDir);
    fs.removeSync(path.join(vaultDir, "foo.schema.yml"));
    await engine.init();
    const schema = engine.notes["bond.ch1"].schema;
    expect(schema).toMatchSnapshot();
    expect(schema).toEqual({ moduleId: "bond", schemaId: "bond" });
  });
});
