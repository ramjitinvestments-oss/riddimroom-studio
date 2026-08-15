/**
 * RiddimRoom Studio — timeline validation.
 *
 * Structural validation for a `Project` before it's trusted (persisted,
 * loaded into an editor, or rendered). Returns a result object rather than
 * throwing, so callers — a future save handler, a future Firestore security
 * rule's client-side pre-check, an import routine — can decide what to do
 * with a batch of errors instead of only ever seeing the first one.
 */

import type { Project, Track, TimelineItem, MediaAsset } from '../../types/timeline';
import { ITEM_TYPE_TO_TRACK_TYPE } from '../../types/timeline';
import { getItemDuration } from './utils';

export interface ValidationError {
  /** Dot-path to the offending field, e.g. "items[2].startTime". */
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validateTrack(track: Track, index: number, errors: ValidationError[]): void {
  const path = `tracks[${index}]`;
  if (!isNonEmptyString(track.id)) errors.push({ path: `${path}.id`, message: 'Track id must be a non-empty string.' });
  if (!['video', 'image', 'text', 'caption', 'audio'].includes(track.type)) {
    errors.push({ path: `${path}.type`, message: `Unknown track type "${track.type}".` });
  }
  if (!isNonEmptyString(track.name)) errors.push({ path: `${path}.name`, message: 'Track name must be a non-empty string.' });
  if (!isFiniteNumber(track.order)) errors.push({ path: `${path}.order`, message: 'Track order must be a finite number.' });
  if (typeof track.visible !== 'boolean') errors.push({ path: `${path}.visible`, message: 'Track visible must be a boolean.' });
}

function validateTransform(
  transform: { position: { x: number; y: number }; scale: number; rotation: number; opacity: number },
  path: string,
  errors: ValidationError[],
): void {
  if (!transform.position || !isFiniteNumber(transform.position.x) || !isFiniteNumber(transform.position.y)) {
    errors.push({ path: `${path}.position`, message: 'position.x and position.y must be finite numbers.' });
  }
  if (!isFiniteNumber(transform.scale) || transform.scale <= 0) {
    errors.push({ path: `${path}.scale`, message: 'scale must be a positive finite number.' });
  }
  if (!isFiniteNumber(transform.rotation)) {
    errors.push({ path: `${path}.rotation`, message: 'rotation must be a finite number.' });
  }
  if (!isFiniteNumber(transform.opacity) || transform.opacity < 0 || transform.opacity > 1) {
    errors.push({ path: `${path}.opacity`, message: 'opacity must be a number between 0 and 1.' });
  }
}

function validateMediaAsset(asset: MediaAsset, key: string, errors: ValidationError[]): void {
  const path = `mediaAssets["${key}"]`;
  if (!isNonEmptyString(asset.id)) errors.push({ path: `${path}.id`, message: 'Media asset id must be a non-empty string.' });
  if (asset.id !== key) errors.push({ path, message: `Media asset key "${key}" does not match its own id "${asset.id}".` });
  if (!['video', 'image', 'audio'].includes(asset.kind)) {
    errors.push({ path: `${path}.kind`, message: `Unknown media asset kind "${asset.kind}".` });
  }
  if (!isNonEmptyString(asset.storageUrl)) errors.push({ path: `${path}.storageUrl`, message: 'storageUrl must be a non-empty string.' });
  if (!isFiniteNumber(asset.sizeBytes) || asset.sizeBytes < 0) errors.push({ path: `${path}.sizeBytes`, message: 'sizeBytes must be a non-negative number.' });
}

function validateItemBase(
  item: TimelineItem,
  index: number,
  trackById: Map<string, Track>,
  errors: ValidationError[],
): void {
  const path = `items[${index}]`;

  if (!isNonEmptyString(item.id)) {
    errors.push({ path: `${path}.id`, message: 'Item id must be a non-empty string.' });
  }
  if (!isNonEmptyString(item.trackId)) {
    errors.push({ path: `${path}.trackId`, message: 'Item trackId must be a non-empty string.' });
  } else {
    const track = trackById.get(item.trackId);
    if (!track) {
      errors.push({ path: `${path}.trackId`, message: `References track "${item.trackId}", which does not exist in this project.` });
    } else {
      const expectedType = ITEM_TYPE_TO_TRACK_TYPE[item.type];
      if (track.type !== expectedType) {
        errors.push({
          path: `${path}.trackId`,
          message: `Item type "${item.type}" must sit on a "${expectedType}" track, but track "${item.trackId}" is type "${track.type}".`,
        });
      }
    }
  }
  if (!isFiniteNumber(item.startTime) || item.startTime < 0) {
    errors.push({ path: `${path}.startTime`, message: 'startTime must be a non-negative finite number.' });
  }
  if (!isFiniteNumber(item.endTime)) {
    errors.push({ path: `${path}.endTime`, message: 'endTime must be a finite number.' });
  }
  if (isFiniteNumber(item.startTime) && isFiniteNumber(item.endTime) && item.endTime <= item.startTime) {
    errors.push({ path: `${path}.endTime`, message: `endTime (${item.endTime}) must be greater than startTime (${item.startTime}).` });
  }
  if (!isFiniteNumber(item.zIndex)) {
    errors.push({ path: `${path}.zIndex`, message: 'zIndex must be a finite number.' });
  }
  if (typeof item.visible !== 'boolean') {
    errors.push({ path: `${path}.visible`, message: 'visible must be a boolean.' });
  }
}

function validateMediaReference(
  mediaAssetId: string | undefined,
  path: string,
  mediaAssets: Record<string, MediaAsset>,
  errors: ValidationError[],
): void {
  if (!isNonEmptyString(mediaAssetId)) {
    errors.push({ path, message: 'mediaAssetId must be a non-empty string.' });
    return;
  }
  if (!mediaAssets[mediaAssetId]) {
    errors.push({ path, message: `References media asset "${mediaAssetId}", which does not exist in this project's mediaAssets.` });
  }
}

function validateTypeSpecificFields(
  item: TimelineItem,
  index: number,
  mediaAssets: Record<string, MediaAsset>,
  errors: ValidationError[],
): void {
  const path = `items[${index}]`;

  switch (item.type) {
    case 'video': {
      validateTransform(item, path, errors);
      validateMediaReference(item.mediaAssetId, `${path}.mediaAssetId`, mediaAssets, errors);
      if (!isFiniteNumber(item.trimStart) || item.trimStart < 0) errors.push({ path: `${path}.trimStart`, message: 'trimStart must be a non-negative finite number.' });
      if (!isFiniteNumber(item.trimEnd) || item.trimEnd <= item.trimStart) errors.push({ path: `${path}.trimEnd`, message: 'trimEnd must be a finite number greater than trimStart.' });
      if (!isFiniteNumber(item.speed) || item.speed <= 0) errors.push({ path: `${path}.speed`, message: 'speed must be a positive finite number.' });
      if (!isFiniteNumber(item.volume) || item.volume < 0 || item.volume > 1) errors.push({ path: `${path}.volume`, message: 'volume must be a number between 0 and 1.' });
      break;
    }
    case 'image': {
      validateTransform(item, path, errors);
      validateMediaReference(item.mediaAssetId, `${path}.mediaAssetId`, mediaAssets, errors);
      if (!['overlay', 'watermark', 'logo', 'sticker', 'photo', 'graphic'].includes(item.role)) {
        errors.push({ path: `${path}.role`, message: `Unknown image item role "${item.role}".` });
      }
      break;
    }
    case 'text': {
      validateTransform(item, path, errors);
      if (typeof item.text !== 'string') errors.push({ path: `${path}.text`, message: 'text must be a string.' });
      if (!isNonEmptyString(item.font)) errors.push({ path: `${path}.font`, message: 'font must be a non-empty string.' });
      if (!isFiniteNumber(item.fontSize) || item.fontSize <= 0) errors.push({ path: `${path}.fontSize`, message: 'fontSize must be a positive finite number.' });
      if (!isNonEmptyString(item.color)) errors.push({ path: `${path}.color`, message: 'color must be a non-empty string.' });
      break;
    }
    case 'caption': {
      if (!Array.isArray(item.words) || item.words.length === 0) {
        errors.push({ path: `${path}.words`, message: 'words must be a non-empty array.' });
      } else {
        const itemDuration = getItemDuration(item);
        item.words.forEach((word, wordIndex) => {
          const wordPath = `${path}.words[${wordIndex}]`;
          if (typeof word.text !== 'string' || word.text.length === 0) {
            errors.push({ path: `${wordPath}.text`, message: 'Word text must be a non-empty string.' });
          }
          if (!isFiniteNumber(word.start) || word.start < 0) {
            errors.push({ path: `${wordPath}.start`, message: 'Word start must be a non-negative finite number.' });
          }
          if (!isFiniteNumber(word.end) || word.end <= word.start) {
            errors.push({ path: `${wordPath}.end`, message: 'Word end must be a finite number greater than start.' });
          }
          if (isFiniteNumber(word.end) && word.end > itemDuration) {
            errors.push({
              path: `${wordPath}.end`,
              message: `Word end (${word.end}s) exceeds this caption item's own duration (${itemDuration}s). Word timings are relative to the item's startTime.`,
            });
          }
        });
      }
      if (!isNonEmptyString(item.captionStyleId)) errors.push({ path: `${path}.captionStyleId`, message: 'captionStyleId must be a non-empty string.' });
      if (!['ai', 'manual'].includes(item.source)) errors.push({ path: `${path}.source`, message: `Unknown caption source "${item.source}".` });
      if (item.editable !== true) errors.push({ path: `${path}.editable`, message: 'Caption items must always have editable: true in this schema.' });
      break;
    }
    case 'audio': {
      validateMediaReference(item.mediaAssetId, `${path}.mediaAssetId`, mediaAssets, errors);
      if (!['original', 'music', 'voiceover', 'sfx'].includes(item.role)) {
        errors.push({ path: `${path}.role`, message: `Unknown audio item role "${item.role}".` });
      }
      if (!isFiniteNumber(item.volume) || item.volume < 0 || item.volume > 1) errors.push({ path: `${path}.volume`, message: 'volume must be a number between 0 and 1.' });
      if (typeof item.muted !== 'boolean') errors.push({ path: `${path}.muted`, message: 'muted must be a boolean.' });
      if (!isFiniteNumber(item.trimStart) || item.trimStart < 0) errors.push({ path: `${path}.trimStart`, message: 'trimStart must be a non-negative finite number.' });
      if (!isFiniteNumber(item.trimEnd) || item.trimEnd <= item.trimStart) errors.push({ path: `${path}.trimEnd`, message: 'trimEnd must be a finite number greater than trimStart.' });
      if (!item.fade || !isFiniteNumber(item.fade.fadeInDuration) || !isFiniteNumber(item.fade.fadeOutDuration)) {
        errors.push({ path: `${path}.fade`, message: 'fade.fadeInDuration and fade.fadeOutDuration must be finite numbers.' });
      }
      break;
    }
    default: {
      // Exhaustiveness check: if a new TimelineItem variant is added to the
      // union without updating this switch, TypeScript will flag the line
      // below as an error (item is not `never`), not at runtime.
      const exhaustiveCheck: never = item;
      errors.push({ path, message: `Unknown item type "${(exhaustiveCheck as TimelineItem).type}".` });
    }
  }
}

/**
 * Validates an entire Project. Rejects (returns valid: false with details
 * for) malformed data rather than silently coercing or dropping it — the
 * project rule is no mock/placeholder behavior for core functionality, and
 * silently "fixing" bad data on load would hide real bugs.
 */
export function validateProject(project: Project): ValidationResult {
  const errors: ValidationError[] = [];

  if (!isNonEmptyString(project.id)) errors.push({ path: 'id', message: 'Project id must be a non-empty string.' });
  if (!isNonEmptyString(project.ownerUid)) errors.push({ path: 'ownerUid', message: 'Project ownerUid must be a non-empty string.' });
  if (!isNonEmptyString(project.name)) errors.push({ path: 'name', message: 'Project name must be a non-empty string.' });
  if (!isFiniteNumber(project.schemaVersion) || project.schemaVersion < 1) {
    errors.push({ path: 'schemaVersion', message: 'schemaVersion must be a positive finite number.' });
  }
  if (!isFiniteNumber(project.canvasWidth) || project.canvasWidth <= 0) errors.push({ path: 'canvasWidth', message: 'canvasWidth must be a positive finite number.' });
  if (!isFiniteNumber(project.canvasHeight) || project.canvasHeight <= 0) errors.push({ path: 'canvasHeight', message: 'canvasHeight must be a positive finite number.' });
  if (!isFiniteNumber(project.frameRate) || project.frameRate <= 0) errors.push({ path: 'frameRate', message: 'frameRate must be a positive finite number.' });

  if (!Array.isArray(project.tracks)) {
    errors.push({ path: 'tracks', message: 'tracks must be an array.' });
  } else {
    project.tracks.forEach((track, index) => validateTrack(track, index, errors));
  }

  const trackIds = Array.isArray(project.tracks) ? project.tracks.map((t) => t.id) : [];
  const duplicateTrackIds = trackIds.filter((id, index) => trackIds.indexOf(id) !== index);
  [...new Set(duplicateTrackIds)].forEach((id) => errors.push({ path: 'tracks', message: `Duplicate track id "${id}".` }));

  const trackById = new Map((project.tracks ?? []).map((track) => [track.id, track]));

  if (!project.mediaAssets || typeof project.mediaAssets !== 'object') {
    errors.push({ path: 'mediaAssets', message: 'mediaAssets must be an object keyed by asset id.' });
  } else {
    Object.entries(project.mediaAssets).forEach(([key, asset]) => validateMediaAsset(asset, key, errors));
  }

  if (!Array.isArray(project.items)) {
    errors.push({ path: 'items', message: 'items must be an array.' });
  } else {
    const itemIds = project.items.map((item) => item.id);
    const duplicateItemIds = itemIds.filter((id, index) => itemIds.indexOf(id) !== index);
    [...new Set(duplicateItemIds)].forEach((id) => errors.push({ path: 'items', message: `Duplicate item id "${id}".` }));

    project.items.forEach((item, index) => {
      validateItemBase(item, index, trackById, errors);
      validateTypeSpecificFields(item, index, project.mediaAssets ?? {}, errors);
    });
  }

  return { valid: errors.length === 0, errors };
}

/** Throws with a combined message if the project is invalid. For call sites that prefer exceptions over result objects. */
export function assertValidProject(project: Project): void {
  const result = validateProject(project);
  if (!result.valid) {
    const details = result.errors.map((e) => `  - ${e.path}: ${e.message}`).join('\n');
    throw new Error(`Invalid Project data (${result.errors.length} error${result.errors.length === 1 ? '' : 's'}):\n${details}`);
  }
}
