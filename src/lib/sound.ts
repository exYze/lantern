let ctx: AudioContext | null = null;

/** A short two-note chime, synthesized so no audio assets are needed. */
export function chime() {
  try {
    ctx ??= new AudioContext();
    const t = ctx.currentTime;
    for (const [i, freq] of [660, 990].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = t + i * 0.12;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.4);
    }
  } catch {
    /* audio unavailable */
  }
}
