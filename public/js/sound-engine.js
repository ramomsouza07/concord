"use strict";

/**
 * Concord Sound Engine
 * Sintetiza via Web Audio API os efeitos sonoros clássicos de chamadas,
 * notificações, mute/deafen, Push-to-Talk e compartilhamento de tela ("Go Live").
 */
class ConcordSoundEngine {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.volume = 0.35;
  }

  ensureContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  playToneSequence(notes) {
    if (!this.enabled) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    for (const note of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = note.type || "sine";
      osc.frequency.setValueAtTime(note.freq, now + note.start);
      if (note.endFreq) {
        osc.frequency.exponentialRampToValueAtTime(note.endFreq, now + note.start + note.duration);
      }

      const peak = (note.gain || 0.5) * this.volume;
      gain.gain.setValueAtTime(0.0001, now + note.start);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.001, peak), now + note.start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + note.start + note.duration);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + note.start);
      osc.stop(now + note.start + note.duration + 0.02);
    }
  }

  playJoin() {
    this.playToneSequence([
      { freq: 587.33, start: 0.0, duration: 0.09, type: "sine", gain: 0.55 }, // D5
      { freq: 880.0, start: 0.085, duration: 0.16, type: "sine", gain: 0.65 } // A5
    ]);
  }

  playLeave() {
    this.playToneSequence([
      { freq: 783.99, start: 0.0, duration: 0.09, type: "sine", gain: 0.5 }, // G5
      { freq: 523.25, start: 0.085, duration: 0.16, type: "sine", gain: 0.55 } // C5
    ]);
  }

  playMute() {
    this.playToneSequence([
      { freq: 440, endFreq: 330, start: 0.0, duration: 0.08, type: "triangle", gain: 0.45 }
    ]);
  }

  playUnmute() {
    this.playToneSequence([
      { freq: 350, endFreq: 520, start: 0.0, duration: 0.08, type: "triangle", gain: 0.45 }
    ]);
  }

  playDeafen() {
    this.playToneSequence([
      { freq: 480, start: 0.0, duration: 0.07, type: "triangle", gain: 0.45 },
      { freq: 310, start: 0.07, duration: 0.11, type: "triangle", gain: 0.45 }
    ]);
  }

  playUndeafen() {
    this.playToneSequence([
      { freq: 310, start: 0.0, duration: 0.07, type: "triangle", gain: 0.45 },
      { freq: 520, start: 0.07, duration: 0.11, type: "triangle", gain: 0.45 }
    ]);
  }

  playStreamStart() {
    this.playToneSequence([
      { freq: 523.25, start: 0.0, duration: 0.08, type: "sine", gain: 0.5 },
      { freq: 659.25, start: 0.07, duration: 0.08, type: "sine", gain: 0.55 },
      { freq: 1046.5, start: 0.14, duration: 0.22, type: "sine", gain: 0.65 }
    ]);
  }

  playStreamStop() {
    this.playToneSequence([
      { freq: 880.0, start: 0.0, duration: 0.08, type: "sine", gain: 0.45 },
      { freq: 659.25, start: 0.07, duration: 0.08, type: "sine", gain: 0.45 },
      { freq: 440.0, start: 0.14, duration: 0.18, type: "sine", gain: 0.45 }
    ]);
  }

  playMessage() {
    this.playToneSequence([
      { freq: 740.0, start: 0.0, duration: 0.055, type: "sine", gain: 0.4 },
      { freq: 987.77, start: 0.05, duration: 0.09, type: "sine", gain: 0.45 }
    ]);
  }

  playPttActivate() {
    this.playToneSequence([
      { freq: 620, start: 0.0, duration: 0.04, type: "sine", gain: 0.3 }
    ]);
  }

  playPttRelease() {
    this.playToneSequence([
      { freq: 460, start: 0.0, duration: 0.04, type: "sine", gain: 0.28 }
    ]);
  }
}

window.concordSounds = new ConcordSoundEngine();
