'use strict';
// ── viewer-media-audio.js ─────────────────────────────────────────────────────
//
// AudioContent: plays audio files using the dedicated <audio> element and
// shows the placeholder element as the visual occupant.

import { requireElement } from './viewer-util.js'
import { PlayableContent } from './viewer-media-playable.js';
import { wireMediaElement } from './viewer-audio.js';
/** @typedef {import('./viewer-util.js').FileListItem} FileListItem */
/** @typedef {import('./viewer-list.js').ItemList} ItemList */

// ── Audio DOM refs ────────────────────────────────────────────────────────────

export var audioEl = requireElement('main-audio', HTMLAudioElement);
export var audioPlaceholderEl = requireElement('audio-placeholder');
wireMediaElement(audioEl);

export class AudioContent extends PlayableContent {
  /**
   * @param {ItemList} creator
   * @param {FileListItem & {p: string}} stats
   */
  constructor(creator, stats) {
    super(creator, stats);
    this._name = 'audio:' + this.fullPath;
  }

  /**
   * @type {HTMLAudioElement}
   */
  get mediaEl() { return audioEl; }

  /**
   * @type {HTMLElement}
   */
  get element() { return audioPlaceholderEl; }

  /**
   * @type {string}
   */
  get controlsMode() { return 'audio'; }

  /**
   * @returns {AudioContent}
   */
  clone() { return new AudioContent(/** @type {ItemList} */ (this._creator), this._stats); }
  // this always works because of the constructor signature
}
