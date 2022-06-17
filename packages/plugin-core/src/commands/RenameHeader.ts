import {
  DendronError,
  DNodeUtils,
  EngagementEvents,
  extractNoteChangeEntryCounts,
  getSlugger,
  NoteProps,
  RenameNotePayload,
  RespV2,
  VaultUtils,
} from "@dendronhq/common-all";
import {
  AnchorUtils,
  DendronASTDest,
  DendronASTTypes,
  Heading,
  MDUtilsV5,
  visit,
} from "@dendronhq/engine-server";
import _ from "lodash";
import { Range, window } from "vscode";
import { DENDRON_COMMANDS } from "../constants";
import { delayedUpdateDecorations } from "../features/windowDecorations";
import { VSCodeUtils } from "../vsCodeUtils";
import { AnalyticsUtils, getAnalyticsPayload } from "../utils/analytics";
import { getExtension } from "../workspace";
import { BasicCommand } from "./base";
import { WSUtils } from "../WSUtils";
import { ExtensionProvider } from "../ExtensionProvider";

type CommandOpts =
  | {
      /** If missing, this will be parsed from the currently selected line. */
      oldHeader?: {
        /** The contents of the old header. */
        text: string;
        /** The region of the document containing the text of the old header. */
        range: Range;
      };
      /** The new text for the header. */
      newHeader?: string;
      /** added for contextual UI analytics. */
      source?: string;
      /** current note that the rename is happening */
      note?: NoteProps;
    }
  | undefined;
export type CommandOutput = RespV2<RenameNotePayload> | undefined;

export class RenameHeaderCommand extends BasicCommand<
  CommandOpts,
  CommandOutput
> {
  key = DENDRON_COMMANDS.RENAME_HEADER.key;

  async gatherInputs(
    opts: CommandOpts
  ): Promise<Required<CommandOpts> | undefined> {
    let { oldHeader, newHeader, source } = opts || {};
    const { editor, selection } = VSCodeUtils.getSelection();
    const extension = ExtensionProvider.getExtension();
    const { wsUtils } = extension;
    const note = wsUtils.getActiveNote();
    if (_.isUndefined(note)) {
      throw new DendronError({
        message: "You must first open a note to rename a header.",
      });
    }
    if (_.isUndefined(oldHeader)) {
      // parse from current selection
      if (!editor || !selection)
        throw new DendronError({
          message: "You must first select the header you want to rename.",
        });
      const line = editor.document.lineAt(selection.start.line).text;
      const proc = MDUtilsV5.procRemarkParseNoData(
        {},
        { dest: DendronASTDest.MD_DENDRON }
      );
      const parsedLine = proc.parse(line);
      let header: Heading | undefined;
      visit(parsedLine, [DendronASTTypes.HEADING], (heading: Heading) => {
        header = heading;
        return false; // There can only be one header in a line
      });
      if (!header)
        throw new DendronError({
          message: "You must first select the header you want to rename.",
        });
      const range = VSCodeUtils.position2VSCodeRange(
        AnchorUtils.headerTextPosition(header),
        { line: selection.start.line }
      );
      const text = AnchorUtils.headerText(header);
      oldHeader = { text, range };
    }
    if (_.isUndefined(newHeader)) {
      // prompt from the user
      newHeader = await window.showInputBox({
        ignoreFocusOut: true,
        placeHolder: "Header text here",
        title: "Rename Header",
        prompt: "Enter the new header text",
        value: oldHeader.text,
      });
      if (!newHeader) return; // User cancelled the prompt
    }
    if (_.isUndefined(source)) {
      source = "command palette";
    }
    return {
      oldHeader,
      newHeader,
      source,
      note,
    };
  }

  async execute(opts: CommandOpts): Promise<CommandOutput> {
    const { oldHeader, newHeader } = opts || {};
    const ctx = "RenameHeaderCommand";
    this.L.info({ ctx, oldHeader, newHeader, msg: "enter" });
    const engine = getExtension().getEngine();
    const editor = VSCodeUtils.getActiveTextEditor();
    if (_.isUndefined(newHeader) || _.isUndefined(oldHeader) || !editor) return;
    const document = editor.document;
    const note = WSUtils.getNoteFromDocument(document);
    if (!note) return;

    const noteLoc = {
      fname: note.fname,
      vaultName: VaultUtils.getName(note?.vault),
    };
    const slugger = getSlugger();

    await editor.edit((editBuilder) => {
      editBuilder.replace(oldHeader.range, newHeader);
    });

    // Parse the new header and extract the text again. This allows us to correctly handle things like wikilinks embedded in the new header.
    let newAnchorHeader = newHeader;
    const proc = MDUtilsV5.procRemarkParseNoData(
      {},
      { dest: DendronASTDest.MD_DENDRON }
    );
    const parsed = proc.parse(`## ${newHeader}`);
    visit(parsed, [DendronASTTypes.HEADING], (node: Heading) => {
      newAnchorHeader = AnchorUtils.headerText(node);
    });

    // Save the updated header, so that same file links update correctly with `renameNote` which reads the files.
    await editor.document.save();
    // This doesn't update the decorations for some reason, we need to update them to get any same-file decorations updated
    delayedUpdateDecorations();

    const out = await engine.renameNote({
      oldLoc: {
        ...noteLoc,
        anchorHeader: slugger.slug(oldHeader.text),
        alias: oldHeader.text,
      },
      newLoc: {
        ...noteLoc,
        anchorHeader: slugger.slug(newAnchorHeader),
        alias: newAnchorHeader,
      },
    });
    return out;
  }

  trackProxyMetrics({
    opts,
    noteChangeEntryCounts,
  }: {
    opts: CommandOpts;
    noteChangeEntryCounts: {
      createdCount?: number;
      deletedCount?: number;
      updatedCount?: number;
    };
  }) {
    if (_.isUndefined(opts)) {
      return;
    }

    const { note } = opts;
    if (_.isUndefined(note)) {
      return;
    }

    const extension = ExtensionProvider.getExtension();
    const engine = extension.getEngine();
    const { vaults } = engine;

    AnalyticsUtils.track(EngagementEvents.RefactoringCommandUsed, {
      command: this.key,
      ...noteChangeEntryCounts,
      numVaults: vaults.length,
      traits: note.traits,
      numChildren: note.children.length,
      numLinks: note.links.length,
      numChars: note.body.length,
      noteDepth: DNodeUtils.getDepth(note),
    });
  }

  addAnalyticsPayload(opts?: CommandOpts, out?: CommandOutput) {
    const noteChangeEntryCounts =
      out && out.data !== undefined
        ? { ...extractNoteChangeEntryCounts(out.data) }
        : {};
    try {
      this.trackProxyMetrics({ opts, noteChangeEntryCounts });
    } catch (error) {
      this.L.error({ error });
    }
    return {
      ...noteChangeEntryCounts,
      ...getAnalyticsPayload(opts?.source),
    };
  }
}
