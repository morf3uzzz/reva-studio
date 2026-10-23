import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import RecordingPanel from "./RecordingPanel";
import RecorderPopover from "./RecorderPopover";
import CameraPreview from "./CameraPreview";
import PreferencesWindow from "./PreferencesWindow";
import SpeakerNotes from "./SpeakerNotes";
import RecordingAreaCover from "./RecordingAreaCover";
import CropEditor from "./CropEditor";
import CapturePicker from "./CapturePicker";
import "./styles.css";

class ErrorBoundary extends React.Component<
  React.PropsWithChildren,
  { message: string | null }
> {
  state = { message: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { message: error.message };
  }
  render() {
    return this.state.message ? (
      <div className="fatal">
        <h1>Something went wrong</h1>
        <p>{this.state.message}</p>
        <button onClick={() => location.reload()}>Reopen editor</button>
      </div>
    ) : (
      this.props.children
    );
  }
}
const surface = new URLSearchParams(location.search).get("surface");
if (surface) document.documentElement.dataset.surface = surface;
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    {surface === "recording-area-cover" ? <RecordingAreaCover /> : surface === "speaker-notes" ? <SpeakerNotes /> : surface === "recorder" ? <RecordingPanel /> : surface === "recorder-popover" ? <RecorderPopover /> : surface === "camera-preview" ? <CameraPreview /> : surface === "preferences" ? <PreferencesWindow /> : surface === "capture-picker" ? <CapturePicker /> : surface === "crop" ? <CropEditor /> : <App />}
  </ErrorBoundary>,
);
