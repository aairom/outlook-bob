import { contextBridge, ipcRenderer } from "electron";

interface MailFolder {
  id: string;
  displayName: string;
  totalItemCount: number;
  childFolderCount: number;
  children?: MailFolder[];
}

export interface ExportParams {
  exportFormat: "recipients-csv" | "emails-csv" | "eml" | "json" | "sqlite";
  includeFrom:            boolean;
  includeToCC:            boolean;
  includeSubject:         boolean;
  includeBodyText:        boolean;
  includeBodyHtml:        boolean;
  includeAttachmentsMeta: boolean;
  filterExcludedDomain:   boolean;
  excludedDomain:         string;
  flaggedOnly:            boolean;
  /** When true, attachment files are saved to disk alongside the primary export. */
  saveAttachments:        boolean;
  /** File-type filter for attachment saving. Empty array = save all types. */
  attachmentTypes:        string[];
  /** When true, the primary export output (file or folder) is compressed into a .zip archive. */
  zipOutput:              boolean;
}

interface MondayBoard {
  id: string;
  name: string;
  description: string | null;
  board_kind: string;
  state: string;
  items_count: number;
  workspace: { id: string; name: string } | null;
  columns: Array<{ id: string; title: string; type: string }>;
}

interface MondayColumnValue {
  id: string;
  type: string;
  text: string;
  label?: string;
  index?: number;
  date?: string;
}

interface MondayItem {
  id: string;
  name: string;
  state: string;
  relative_link: string;
  column_values: MondayColumnValue[];
}

interface PreviewMessage {
  id: string;
  sentDateTime: string;
  from: string;
  fromName: string;
  to: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  isRead: boolean;
  isFlagged: boolean;
  importance: string;
  hasAttachments: boolean;
  folder: string;
}

contextBridge.exposeInMainWorld("electronAPI", {
  // ── Queries ────────────────────────────────────────────────────────────────
  getStatus: (): Promise<{ authenticated: boolean; mondayBaseUrl: string }> =>
    ipcRenderer.invoke("get-status"),

  connect: (): Promise<{ authenticated: boolean }> =>
    ipcRenderer.invoke("connect"),

  listFolders: (): Promise<{ folders: MailFolder[] }> =>
    ipcRenderer.invoke("list-folders"),

  startExtraction: (args: {
    folderIds: string[];
    folderTree: MailFolder[];
    since?: string;
    exportParams: ExportParams;
  }): Promise<void> =>
    ipcRenderer.invoke("start-extraction", args),

  openFile: (filePath: string): Promise<void> =>
    ipcRenderer.invoke("open-file", { path: filePath }),

  listMondayBoards: (): Promise<{ boards: MondayBoard[] }> =>
    ipcRenderer.invoke("list-monday-boards"),

  getMondayBoardItems: (boardId: string): Promise<{
    columns: Array<{ id: string; title: string; type: string }>;
    items: MondayItem[];
    error?: string;
  }> =>
    ipcRenderer.invoke("get-monday-board-items", { boardId }),

  createMondayItem: (boardId: string, itemName: string): Promise<{
    item: { id: string; name: string } | null;
    error?: string;
  }> =>
    ipcRenderer.invoke("create-monday-item", { boardId, itemName }),

  previewEmails: (args: {
    folderIds: string[];
    folderTree: MailFolder[];
    since?: string;
    limit?: number;
    flaggedOnly?: boolean;
  }): Promise<{ messages: PreviewMessage[]; error?: string }> =>
    ipcRenderer.invoke("preview-emails", args),

  // ── Events ─────────────────────────────────────────────────────────────────
  onProgress: (cb: (message: string) => void) => {
    ipcRenderer.on("progress", (_e, payload: { message: string }) => cb(payload.message));
  },

  onDone: (cb: (outputPath: string, count: number, format: string) => void) => {
    ipcRenderer.on("done", (_e, payload: { outputPath: string; count: number; format: string }) =>
      cb(payload.outputPath, payload.count, payload.format)
    );
  },

  onError: (cb: (message: string) => void) => {
    ipcRenderer.on("error", (_e, payload: { message: string }) => cb(payload.message));
  },

  onMondayError: (cb: (message: string) => void) => {
    ipcRenderer.on("monday-error", (_e, payload: { message: string }) => cb(payload.message));
  },

  removeAllListeners: (channel: string) => {
    ipcRenderer.removeAllListeners(channel);
  },
});
