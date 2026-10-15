/** A resource's latest confirmed response controls its sign-in recovery state. */
export type WorkspaceAccessObserver = (resource: string, status: number) => void;
