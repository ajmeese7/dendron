import {
  DendronError,
  DVault,
  DWorkspace,
  ERROR_STATUS,
  FOLDERS,
  VaultRemoteSource,
  VaultUtils,
  WorkspaceType,
} from "@dendronhq/common-all";
import {
  assignJSONWithComment,
  GitUtils,
  simpleGit,
} from "@dendronhq/common-server";
import { WorkspaceService, WorkspaceUtils } from "@dendronhq/engine-server";
import fs from "fs-extra";
import _ from "lodash";
import path from "path";
import { commands, ProgressLocation, QuickPickItem, window } from "vscode";
import { PickerUtilsV2 } from "../components/lookup/utils";
import { DENDRON_COMMANDS, DENDRON_REMOTE_VAULTS } from "../constants";
import { ExtensionProvider } from "../ExtensionProvider";
import { Logger } from "../logger";
import { VSCodeUtils } from "../vsCodeUtils";
import { BasicCommand } from "./base";

type CommandOpts = {
  type: VaultRemoteSource;
  path: string;
  pathRemote?: string;
  name?: string;
  isSelfContained?: boolean;
};

type CommandOutput = { vaults: DVault[] };

export { CommandOpts as VaultAddCommandOpts };

type SourceQuickPickEntry = QuickPickItem & { src: string };

export class VaultAddCommand extends BasicCommand<CommandOpts, CommandOutput> {
  key = DENDRON_COMMANDS.VAULT_ADD.key;

  generateRemoteEntries = (): SourceQuickPickEntry[] => {
    return (
      DENDRON_REMOTE_VAULTS.map(({ name: label, description, data: src }) => {
        return { label, description, src };
      }) as SourceQuickPickEntry[]
    ).concat([
      {
        label: "custom",
        description: "custom endpoint",
        alwaysShow: true,
        src: "",
      },
    ]);
  };

  async gatherVaultStandard(
    sourceType: VaultRemoteSource
  ): Promise<CommandOpts | undefined> {
    const localVaultPathPlaceholder = "vault2";
    let sourcePath: string;
    let sourceName: string | undefined;
    if (sourceType === "remote") {
      // eslint-disable-next-line  no-async-promise-executor
      const out = new Promise<CommandOpts | undefined>(async (resolve) => {
        const qp = VSCodeUtils.createQuickPick<SourceQuickPickEntry>();
        qp.ignoreFocusOut = true;
        qp.placeholder = "choose a preset or enter a custom git endpoint";
        qp.items = this.generateRemoteEntries();
        qp.onDidAccept(async () => {
          const value = qp.value;
          const selected = qp.selectedItems[0];
          if (selected.label === "custom") {
            if (PickerUtilsV2.isInputEmpty(value)) {
              return window.showInformationMessage("please enter an endpoint");
            }
            selected.src = qp.value;
          }
          const sourceRemotePath = selected.src;
          const path2Vault =
            selected.label === "custom"
              ? GitUtils.getRepoNameFromURL(sourceRemotePath)
              : selected.label;
          const placeHolder = path2Vault;

          const out = await VSCodeUtils.showInputBox({
            prompt: "Path to your new vault (relative to your workspace root)",
            placeHolder: localVaultPathPlaceholder,
            value: path2Vault,
          });
          if (PickerUtilsV2.isInputEmpty(out)) {
            resolve(undefined);
          }
          sourcePath = out!;

          sourceName = await VSCodeUtils.showInputBox({
            prompt: "Name of new vault (optional, press enter to skip)",
            value: placeHolder,
          });
          qp.hide();
          return resolve({
            type: sourceType!,
            name: sourceName,
            path: sourcePath,
            pathRemote: sourceRemotePath,
          });
        });
        qp.show();
      });
      return out;
    } else {
      const out = await VSCodeUtils.showInputBox({
        prompt: "Path to your new vault (relative to your workspace root)",
        placeHolder: localVaultPathPlaceholder,
      });
      if (PickerUtilsV2.isInputEmpty(out)) return;
      sourcePath = out!;
    }
    sourceName = await VSCodeUtils.showInputBox({
      prompt: "Name of new vault (optional, press enter to skip)",
    });
    return {
      type: sourceType,
      name: sourceName,
      path: sourcePath,
    };
  }

  async gatherVaultSelfContained(
    sourceType: VaultRemoteSource
  ): Promise<CommandOpts | undefined> {
    // For self contained vaults, we'll have the vault name match the folder for
    // now. We can make this flexible later if that's a better UX, or give
    // instructions on the wiki on how to change the name later.
    const vaultName = await VSCodeUtils.showInputBox({
      prompt: "Name for the new vault",
    });
    // If empty, then user cancelled the prompt
    if (PickerUtilsV2.isInputEmpty(vaultName)) return;
    // If the vault name already exists, creating a vault with the same name would break things
    const { config } = ExtensionProvider.getDWorkspace();
    if (config.vaults?.map(VaultUtils.getName).includes(vaultName)) {
      throw new DendronError({
        message: `There is already a vault with the name ${vaultName}, please pick a different name.`,
      });
    }

    if (sourceType === "local") {
      // Local vault
      return {
        type: sourceType,
        name: vaultName,
        path: path.join(
          FOLDERS.DEPENDENCIES,
          FOLDERS.LOCAL_DEPENDENCY,
          vaultName
        ),
        isSelfContained: true,
      };
    } else {
      // Remote vault
      const remote = await VSCodeUtils.showInputBox({
        title: "Remote URL",
        prompt: "Enter the URL for the git remote",
        placeHolder: "git@github.com:dendronhq/dendron.git",
        ignoreFocusOut: true,
      });
      // Cancelled
      if (PickerUtilsV2.isInputEmpty(remote)) return;

      return {
        type: sourceType,
        name: vaultName,
        path: path.join(
          FOLDERS.DEPENDENCIES,
          GitUtils.remoteUrlToDependencyPath({
            vaultName,
            url: remote,
          })
        ),
        isSelfContained: true,
      };
    }
  }

  async gatherInputs(): Promise<CommandOpts | undefined> {
    const sourceTypeSelected = await VSCodeUtils.showQuickPick([
      { label: "local", picked: true },
      { label: "remote" },
    ]);
    if (!sourceTypeSelected) {
      return;
    }
    const sourceType = sourceTypeSelected.label as VaultRemoteSource;

    const { config } = ExtensionProvider.getDWorkspace();
    if (config.dev?.enableSelfContainedVaults) {
      return this.gatherVaultSelfContained(sourceType);
    } else {
      // A "standard", non self contained vault
      return this.gatherVaultStandard(sourceType);
    }
  }

  async handleRemoteRepo(
    opts: CommandOpts
  ): Promise<{ vaults: DVault[]; workspace?: DWorkspace }> {
    const { vaults, workspace } = await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: "Adding remote vault",
        cancellable: false,
      },
      async (progress) => {
        progress.report({
          message: "cloning repo",
        });
        const baseDir = ExtensionProvider.getDWorkspace().wsRoot;
        const git = simpleGit({ baseDir });
        await git.clone(opts.pathRemote!, opts.path);
        const { vaults, workspace } = GitUtils.getVaultsFromRepo({
          repoPath: path.join(baseDir, opts.path),
          wsRoot: ExtensionProvider.getDWorkspace().wsRoot,
          repoUrl: opts.pathRemote!,
        });
        if (_.size(vaults) === 1 && opts.name) {
          vaults[0].name = opts.name;
        }
        // add all vaults
        progress.report({
          message: "adding vault",
        });
        const wsRoot = ExtensionProvider.getDWorkspace().wsRoot;
        const wsService = new WorkspaceService({ wsRoot });

        if (workspace) {
          await wsService.addWorkspace({ workspace });
          await this.addWorkspaceToWorkspace(workspace);
        } else {
          // Some things, like updating config, can't be parallelized so needs to be done one at a time
          for (const vault of vaults) {
            // eslint-disable-next-line no-await-in-loop
            await wsService.createVault({ vault });
            // eslint-disable-next-line no-await-in-loop
            await this.addVaultToWorkspace(vault);
          }
        }
        return { vaults, workspace };
      }
    );
    return { vaults, workspace };
  }

  async addWorkspaceToWorkspace(workspace: DWorkspace) {
    const wsRoot = ExtensionProvider.getDWorkspace().wsRoot;
    const vaults = workspace.vaults;
    // Some things, like updating workspace file, can't be parallelized so needs to be done one at a time
    for (const vault of vaults) {
      // eslint-disable-next-line no-await-in-loop
      await this.addVaultToWorkspace(vault);
    }
    // add to gitignore
    await GitUtils.addToGitignore({
      addPath: workspace.name,
      root: wsRoot,
      noCreateIfMissing: true,
    });

    const workspaceDir = path.join(wsRoot, workspace.name);
    fs.ensureDir(workspaceDir);
    await GitUtils.addToGitignore({
      addPath: ".dendron.cache.*",
      root: workspaceDir,
    });
  }

  async addVaultToWorkspace(vault: DVault) {
    if (ExtensionProvider.getExtension().type === WorkspaceType.NATIVE) return;
    const { wsRoot } = ExtensionProvider.getDWorkspace();

    // workspace file
    const resp = await WorkspaceUtils.getCodeWorkspaceSettings(wsRoot);
    if (resp.error) {
      throw DendronError.createFromStatus({
        status: ERROR_STATUS.INVALID_STATE,
        message: "no dendron.code-workspace found",
      });
    }
    let wsSettings = resp.data;

    if (
      !_.find(
        wsSettings.folders,
        (ent) => ent.path === VaultUtils.getRelPath(vault)
      )
    ) {
      const vault2Folder = VaultUtils.toWorkspaceFolder(vault);
      const folders = [vault2Folder].concat(wsSettings.folders);
      wsSettings = assignJSONWithComment({ folders }, wsSettings);
      WorkspaceUtils.writeCodeWorkspaceSettings({
        settings: wsSettings,
        wsRoot,
      });
    }

    // check for .gitignore
    await GitUtils.addToGitignore({
      addPath: vault.fsPath,
      root: wsRoot,
      noCreateIfMissing: true,
    });

    const vaultDir = path.join(wsRoot, vault.fsPath);
    fs.ensureDir(vaultDir);
    await GitUtils.addToGitignore({
      addPath: ".dendron.cache.*",
      root: vaultDir,
    });
    return;
  }

  /**
   * Returns all vaults added
   * @param opts
   * @returns
   */
  async execute(opts: CommandOpts) {
    const ctx = "VaultAdd";
    let vaults: DVault[] = [];
    Logger.info({ ctx, msg: "enter", opts });
    if (opts.type === "remote") {
      ({ vaults } = await this.handleRemoteRepo(opts));
    } else {
      const wsRoot = ExtensionProvider.getDWorkspace().wsRoot;
      const fsPath = VaultUtils.normVaultPath({
        vault: { fsPath: opts.path },
        wsRoot,
      });
      const wsService = new WorkspaceService({ wsRoot });
      const vault: DVault = {
        fsPath,
        name: opts.name,
        selfContained: opts.isSelfContained,
      };

      if (VaultUtils.isSelfContained(vault)) {
        await wsService.createSelfContainedVault({
          vault,
          addToConfig: true,
          addToCodeWorkspace: false,
        });
      } else {
        await wsService.createVault({ vault });
      }
      await this.addVaultToWorkspace(vault);
      vaults = [vault];
    }
    window.showInformationMessage("finished adding vault");
    await commands.executeCommand("workbench.action.reloadWindow");
    return { vaults };
  }
}
