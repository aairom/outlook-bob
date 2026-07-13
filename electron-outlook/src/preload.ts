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
}

contextBridge.exposeInMainWorld("electronAPI", {
  // ── Queries ────────────────────────────────────────────────────────────────
  getStatus: (): Promise<{ authenticated: boolean }> =>
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

  removeAllListeners: (channel: string) => {
    ipcRenderer.removeAllListeners(channel);
  },
});
