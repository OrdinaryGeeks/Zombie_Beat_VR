/**
 * The groove, and the band's own instruments, played straight on Web Audio.
 *
 * Its own `AudioContext`, because a rhythm game judges presses against when the beat actually
 * sounded, and only a scheduler that owns its context's clock knows that. Everything is
 * synthesised: there are no audio files.
 *
 * A browser will not start audio before a user gesture, so `start()` is called from one (the
 * first press, or entering VR). Until then the clock runs on the wall clock, so the stage still
 * pulses in silence.
 *
 * Beat 0 is the Unix epoch rather than page load, so everyone playing together counts the same
 * beats (to within how far apart their machines' clocks are), and audio takes over at that phase.
 */
export class Groove {
  ctx = null;
  master = null;
  noise = null;
  /** Audio time of beat 0. */
  origin = 0;
  /** The next sixteenth to schedule. */
  nextStep = 0;
  secondsPerBeat;
  constructor(bpm) {
    this.secondsPerBeat = 60 / bpm;
  }
  get started() {
    return this.ctx !== null;
  }
  /**
   * Seconds on the beat clock. Continuous across `start()`: the audio origin is chosen so the beat
   * the player was already watching is the beat they then hear.
   */
  now() {
    if (this.ctx) return this.ctx.currentTime - this.origin;
    // The last 100,000 beats of epoch time: a whole number of beats, so the phase is unchanged.
    return (Date.now() % (100_000 * this.secondsPerBeat * 1000)) / 1000;
  }
  start() {
    if (this.ctx) {
      void this.ctx.resume().catch(() => void 0);
      return;
    }
    const Ctor = globalThis.AudioContext;
    if (!Ctor) return;
    const silentNow = this.now();
    const ctx = new Ctor();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.55;
    this.master.connect(ctx.destination);
    this.noise = makeNoise(ctx);
    this.origin = ctx.currentTime - silentNow;
    this.nextStep = Math.ceil(silentNow / this.secondsPerBeat * 4);
    void ctx.resume().catch(() => void 0);
  }
  /** Schedules the groove a little ahead of the clock. Called every frame; cheap when nothing is due. */
  pump(hype) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const step = this.secondsPerBeat / 4;
    const horizon = ctx.currentTime + 0.12;
    while (this.origin + this.nextStep * step < horizon) {
      this.scheduleStep(this.nextStep, this.origin + this.nextStep * step, hype);
      this.nextStep++;
    }
  }
  /** The player's instrument answering a press. A miss is a dud, not silence: you hear that you were off. */
  play(role, grade) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const t = ctx.currentTime;
    const level = grade === "perfect" ? 1 : grade === "good" ? 0.7 : 0.35;
    switch (role) {
      case "guitarist":
        for (const [freq, detune] of [[110, -8], [110, 8], [164.8, 0], [220, 4]]) {
          this.tone("sawtooth", grade === "miss" ? freq * 0.94 : freq, t, 0.45, 0.16 * level, detune, 2600);
        }
        break;
      case "drummer":
        this.kick(t, 1.1 * level);
        this.hit(t, 0.35, 0.5 * level, 6e3);
        this.tone("sine", 140, t, 0.25, 0.5 * level, 0, 0, 70);
        break;
      case "singer": {
        const freq = grade === "miss" ? 311 : grade === "perfect" ? 440 : 392;
        this.voice(freq, t, 0.6, 0.22 * level);
        break;
      }
      case "dancer":
        this.hit(t, 0.08, 0.6 * level, 1800);
        this.hit(t + 0.06, 0.08, 0.5 * level, 2200);
        this.kick(t, 0.5 * level);
        break;
    }
  }
  /** An ultimate: a rising sweep into a crash, then the role's own sound three times over. */
  ultimate(role) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    this.tone('sawtooth', 110, t, 0.35, 0.18, 0, 3000, 880);
    this.hit(t + 0.1, 1.2, 0.6, 2500);
    this.kick(t + 0.1, 1.3);
    if (role === 'guitarist') {
      for (const [freq, at] of [[110, 0.1], [146.8, 0.35], [164.8, 0.6]]) {
        for (const detune of [-10, 0, 10]) this.tone('sawtooth', freq, t + at, 0.7, 0.14, detune, 3200);
      }
    } else if (role === 'drummer') {
      for (let i = 0; i < 6; i++) this.hit(t + 0.1 + i * 0.07, 0.15, 0.5, 3000 + i * 600);
      this.kick(t + 0.55, 1.4);
    } else if (role === 'singer') {
      this.voice(523, t + 0.1, 1.1, 0.26);
      this.voice(659, t + 0.1, 1.1, 0.14);
    } else {
      for (let i = 0; i < 8; i++) this.hit(t + 0.1 + i * 0.12, 0.08, 0.45, 1800 + (i % 2) * 600);
    }
  }

  /** A low thud, for a zombie reaching the centre. */
  breach() {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const t = ctx.currentTime;
    this.tone("square", 55, t, 0.5, 0.25, 0, 400, 40);
    this.tone("square", 58, t + 0.12, 0.5, 0.2, 0, 400, 40);
  }
  dispose() {
    void this.ctx?.close().catch(() => void 0);
    this.ctx = null;
    this.master = null;
  }
  // ── the drum machine ──────────────────────────────────────────────────────────────────────
  scheduleStep(index, at, hype) {
    const sixteenth = (index % 16 + 16) % 16;
    const beat = sixteenth / 4;
    if (sixteenth % 4 === 0) this.kick(at, 0.9);
    if (sixteenth === 4 || sixteenth === 12) this.hit(at, 0.18, 0.45, 3200);
    if (sixteenth % 2 === 1 || hype > 0.6 && sixteenth % 4 !== 0) this.hit(at, 0.04, 0.12, 9e3);
    const bassLine = [55, 55, 65.4, 49];
    if (sixteenth % 4 === 2 || hype > 0.35 && sixteenth % 8 === 3) {
      this.tone("sawtooth", bassLine[Math.floor(beat) % bassLine.length], at, 0.18, 0.13, 0, 500);
    }
  }
  kick(at, gain) {
    this.tone("sine", 150, at, 0.32, gain, 0, 0, 42);
  }
  hit(at, length, gain, highpass) {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = highpass;
    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, at);
    env.gain.exponentialRampToValueAtTime(1e-4, at + length);
    source.connect(filter).connect(env).connect(this.master);
    source.start(at);
    source.stop(at + length + 0.02);
  }
  tone(wave, freq, at, length, gain, detune = 0, lowpass = 0, sweepTo = 0) {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const osc = ctx.createOscillator();
    osc.type = wave;
    osc.frequency.setValueAtTime(freq, at);
    if (sweepTo > 0) osc.frequency.exponentialRampToValueAtTime(sweepTo, at + length);
    osc.detune.value = detune;
    const env = ctx.createGain();
    env.gain.setValueAtTime(1e-4, at);
    env.gain.exponentialRampToValueAtTime(Math.max(2e-4, gain), at + 5e-3);
    env.gain.exponentialRampToValueAtTime(1e-4, at + length);
    let node = osc;
    if (lowpass > 0) {
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(lowpass, at);
      filter.frequency.exponentialRampToValueAtTime(Math.max(200, lowpass / 4), at + length);
      osc.connect(filter);
      node = filter;
    }
    node.connect(env).connect(this.master);
    osc.start(at);
    osc.stop(at + length + 0.02);
  }
  voice(freq, at, length, gain) {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.5;
    const depth = ctx.createGain();
    depth.gain.value = freq * 0.012;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = freq;
    lfo.connect(depth).connect(osc.frequency);
    const formant = ctx.createBiquadFilter();
    formant.type = "bandpass";
    formant.frequency.value = 900;
    formant.Q.value = 1.2;
    const env = ctx.createGain();
    env.gain.setValueAtTime(1e-4, at);
    env.gain.exponentialRampToValueAtTime(gain, at + 0.06);
    env.gain.exponentialRampToValueAtTime(1e-4, at + length);
    osc.connect(formant).connect(env).connect(this.master);
    osc.start(at);
    lfo.start(at);
    osc.stop(at + length + 0.02);
    lfo.stop(at + length + 0.02);
  }
}
function makeNoise(ctx) {
  const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}
