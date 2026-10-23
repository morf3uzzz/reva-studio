import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Modal } from "./components";
import { t, useLanguage } from "./i18n";
import type { RecoveryListing, RecoveryResult } from "./types";

export default function RecoveryDialog({ onClose, onRecovered, onBusy }: { onClose: () => void; onRecovered: (result: RecoveryResult) => Promise<void>; onBusy: (value: boolean) => void }) {
  const [language] = useLanguage();
  const [listing, setListing] = useState<RecoveryListing | null>(null), [running, setRunning] = useState<string | null>(null), [failure, setFailure] = useState("");
  const refresh = async () => { try { setListing(await window.reva!.listRecordingRecovery()); } catch (error) { setFailure(error instanceof Error ? error.message : String(error)); } };
  useEffect(() => { void refresh(); return () => { onBusy(false); }; }, []);
  const recover = async (id: string) => {
    setRunning(id); setFailure(""); onBusy(true);
    try { const result = await window.reva!.recoverRecording(id); if (result) { await onRecovered(result); onClose(); } }
    catch (error) { setFailure(error instanceof Error ? error.message : String(error)); }
    finally { setRunning(null); onBusy(false); }
  };
  return <Modal title={t("Recover interrupted recordings")} subtitle={t("Recover completed media fragments into a new folder. Original files are preserved.")} onClose={running ? () => {} : onClose}>
    {!listing ? <div className="sources-loading"><LoaderCircle className="spin" /><span>{t("Checking local recordings…")}</span></div> : <>
      {!listing.recordings.length && <p className="panel-note">{t("No recoverable interrupted recording was found.")}</p>}
      {listing.recordings.map(recording => <div key={recording.id} className="recovery-recording" style={{ padding: "12px 0", borderBottom: "1px solid #ffffff16" }}>
        <strong>{t("Interrupted recording — {date}", { date: new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "medium" }).format(new Date(recording.createdAt)) })}</strong><p className="panel-note">{recording.width} × {recording.height} · {t("{value}s", { value: recording.checkpointDuration.toFixed(1) })} · {recording.source}</p>
        <p className="panel-note">{t("The last incomplete fragment may be unavailable. Recovery reports any missing media or metadata.")}</p>
        {recording.error && <p className="panel-note">{recording.error}</p>}
        {recording.recoveredPath && <p className="panel-note">{t("Already recovered")}: {recording.recoveredPath}</p>}
        <button className="outline-button" disabled={running !== null} onClick={() => void recover(recording.id)}>{running === recording.id ? t("Recovering…") : t(recording.recoveredPath ? "Recover another copy" : "Recover recording")}</button>
      </div>)}
      {listing.issues.map((issue, index) => <p className="panel-note" key={index}>{issue.message}{issue.path && <><br /><span>{issue.path}</span></>}</p>)}
    </>}
    {failure && <p role="alert" className="panel-note">{failure}</p>}
    <div className="modal-actions">{running ? <button onClick={() => void window.reva!.cancelRecordingRecovery().catch(error => setFailure(String(error)))}>{t("Cancel recovery")}</button> : <><button onClick={() => void refresh()}>{t("Refresh")}</button><button onClick={onClose}>{t("Close")}</button></>}</div>
  </Modal>;
}
