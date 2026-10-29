import React from 'react';
import { Camera, Upload } from 'lucide-react';
import { requestRecordPip, requestUploadPip } from '../../lib/pipRequests';

/**
 * R36 WS-1 — the equal primary PiP add actions: "Record PiP" and
 * "Upload PiP", side by side at the same size and weight wherever a
 * PiP is being added or a PiP slot is empty (PipPanel empty state,
 * the timeline Overlay lane's empty state, the import panel).
 *
 * By default the buttons dispatch the PiP request events
 * (lib/pipRequests) that MediaImportPanel listens for — it owns the
 * camera and the overlay file input, so no surface builds its own
 * capture/upload path. A surface that already owns those (the import
 * panel itself) passes its own handlers instead.
 */
export function PipAddButtons({
  onRecord,
  onUpload,
}: {
  onRecord?: () => void;
  onUpload?: () => void;
}) {
  const buttonClass =
    'min-h-11 flex-1 px-3 rounded-lg border border-gold/60 bg-gold/15 hover:bg-gold/25 text-gold text-xs font-bold uppercase tracking-wide flex items-center justify-center gap-2 transition';
  return (
    <div className="flex gap-2">
      <button type="button" onClick={onRecord ?? (() => requestRecordPip())} className={buttonClass}>
        <Camera size={15} /> Record PiP
      </button>
      <button type="button" onClick={onUpload ?? (() => requestUploadPip())} className={buttonClass}>
        <Upload size={15} /> Upload PiP
      </button>
    </div>
  );
}
