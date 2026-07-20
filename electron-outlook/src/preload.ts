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

interface BoxFolder {
  id: string;
  name: string;
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

  addMondayItemUpdate: (itemId: string, body: string): Promise<{
    update: { id: string } | null;
    error?: string;
  }> =>
    ipcRenderer.invoke("add-monday-item-update", { itemId, body }),

  previewEmails: (args: {
    folderIds: string[];
    folderTree: MailFolder[];
    since?: string;
    limit?: number;
    flaggedOnly?: boolean;
  }): Promise<{ messages: PreviewMessage[]; error?: string }> =>
    ipcRenderer.invoke("preview-emails", args),

  downloadSelectedEmails: (args: {
    messages: PreviewMessage[];
  }): Promise<{ count: number; outputPath: string; error?: string }> =>
    ipcRenderer.invoke("download-selected-emails", args),

  connectBox: (): Promise<{ connected: boolean; error?: string }> =>
    ipcRenderer.invoke("connect-box"),

  boxLogout: (): Promise<void> =>
    ipcRenderer.invoke("box-logout"),

  getBoxStatus: (): Promise<{ connected: boolean }> =>
    ipcRenderer.invoke("get-box-status"),

  listBoxFolders: (): Promise<{ folders: BoxFolder[]; error?: string }> =>
    ipcRenderer.invoke("list-box-folders"),

  uploadToBox: (args: {
    localPath: string;
    boxFolderId: string;
    newFolderName?: string;
  }): Promise<{ boxFileId: string; boxFileName: string; error?: string }> =>
    ipcRenderer.invoke("upload-to-box", args),

  getBoxDriveStatus: (): Promise<{ available: boolean; mountPath: string }> =>
    ipcRenderer.invoke("get-boxdrive-status"),

  listBoxDriveFolders: (): Promise<{ folders: Array<{ name: string; path: string }>; mountPath: string; error?: string }> =>
    ipcRenderer.invoke("list-boxdrive-folders"),

  copyToBoxDrive: (args: {
    localPath: string;
    boxDriveFolderPath: string;
    newFolderName?: string;
  }): Promise<{ destPath: string; fileName: string; error?: string }> =>
    ipcRenderer.invoke("copy-to-boxdrive", args),

  getOneDriveStatus: (): Promise<{ connected: boolean }> =>
    ipcRenderer.invoke("get-onedrive-status"),

  listOneDriveFolders: (): Promise<{ folders: Array<{ id: string; name: string; path: string }>; error?: string }> =>
    ipcRenderer.invoke("list-onedrive-folders"),

  uploadToOneDrive: (args: {
    localPath: string;
    oneDriveFolderId: string;
    newFolderName?: string;
  }): Promise<{ odFileId: string; odFileName: string; odWebUrl: string; error?: string }> =>
    ipcRenderer.invoke("upload-to-onedrive", args),

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
