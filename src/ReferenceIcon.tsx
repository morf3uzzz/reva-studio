// Semantic names retained by the editor; all artwork is Lucide (ISC), not a font.
import { Proportions, Crop, Hexagon, ZoomOut, ZoomIn, CircleStop, CirclePause,
  CirclePlay, SkipBack, SkipForward, AudioLines, Undo2, Trash2, CircleX, PanelBottom,
  AppWindow, Scan, Smartphone, Video, VideoOff, Mic, MicOff, Music, Folder, Settings,
  ChevronDown, ScanLine, MousePointer2, PictureInPicture2, ScanFace, Captions,
  Volume1, MousePointerClick, Spline } from 'lucide-react';
const icons={
  aspectratio:Proportions,crop:Crop,'circle.hexagongrid':Hexagon,
  'minus.magnifyingglass':ZoomOut,'plus.magnifyingglass':ZoomIn,
  'stop.circle':CircleStop,'pause.circle':CirclePause,'play.circle':CirclePlay,
  'backward.end':SkipBack,'forward.end':SkipForward,'waveform.badge.magnifyingglass':AudioLines,
  'arrow.counterclockwise':Undo2,trash:Trash2,'xmark.circle.fill':CircleX,
  'dock.rectangle':PanelBottom,macwindow:AppWindow,'square.dashed':Scan,
  'apps.iphone':Smartphone,video:Video,'video.slash':VideoOff,'microphone.fill':Mic,
  'microphone.slash.fill':MicOff,'music.note.tv':Music,folder:Folder,gear:Settings,
  'chevron.down':ChevronDown,'inset.filled.square.dashed':ScanLine,cursorarrow:MousePointer2,
  'inset.filled.rectangle.and.person.filled':PictureInPicture2,'person.fill.viewfinder':ScanFace,
  'captions.bubble':Captions,'speaker.wave.1':Volume1,'cursorarrow.motionlines.click':MousePointerClick,
  'point.topleft.down.to.point.bottomright.curvepath.fill':Spline,
} as const;
export default function ReferenceIcon({name,size=16}:{name:keyof typeof icons;size?:number}) {
  const Icon=icons[name];
  return <span className="reference-symbol" aria-hidden="true" style={{fontSize:size}}><Icon size={size} strokeWidth={1.8}/></span>;
}
