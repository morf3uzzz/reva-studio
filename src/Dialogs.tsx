import { t } from "./i18n";
import { Modal } from "./components";
export { default as ExportDialog } from "./ExportPanel";

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      title="Keyboard shortcuts"
      subtitle="Keep your hands on the keys."
      onClose={onClose}
    >
      <div className="shortcut-list">
        {[
          ["New recording", "⌘ N"],
          ["Open project", "⌘ O"],
          ["Import video", "⌘ ⇧ O"],
          ["Save project", "⌘ S"],
          ["Export video", "⌘ E"],
          ["Play / pause", "Space"],
          ["Go to first frame", "⌘ ←"],
          ["Go to last frame", "⌘ →"],
          ["Previous / next frame", "← / →"],
          ["Add zoom at playhead", "Z"],
          ["Cut recording", "⌃ / ⌥"],
          ["Trim start to playhead", "["],
          ["Trim end to playhead", "]"],
          ["Undo", "⌘ Z"],
          ["Redo", "⌘ ⇧ Z"],
          ["Stop recording", "⌘ ⇧ 2"],
        ].map(([label, key]) => (
          <div key={label}>
            <span>{t(label)}</span>
            <kbd>{t(key)}</kbd>
          </div>
        ))}
      </div>
    </Modal>
  );
}
