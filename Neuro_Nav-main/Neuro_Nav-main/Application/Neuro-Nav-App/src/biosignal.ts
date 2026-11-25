/** Shared biosignal + demo logic (ported from web `app.js`) */

export const SR = 40;
export const WINDOW_SEC = 8;
export const N = SR * WINDOW_SEC;

export function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

export function fmt(n: number, digits = 2) {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

export class RingBuffer {
  size: number;
  a: Float32Array;
  i = 0;
  full = false;

  constructor(size: number) {
    this.size = size;
    this.a = new Float32Array(size);
  }

  push(v: number) {
    this.a[this.i] = v;
    this.i = (this.i + 1) % this.size;
    if (this.i === 0) this.full = true;
  }

  length() {
    return this.full ? this.size : this.i;
  }

  toArray(): Float32Array {
    const n = this.length();
    const out = new Float32Array(n);
    if (!this.full) {
      out.set(this.a.subarray(0, n), 0);
      return out;
    }
    const tail = this.a.subarray(this.i);
    const head = this.a.subarray(0, this.i);
    out.set(tail, 0);
    out.set(head, tail.length);
    return out;
  }

  rms() {
    const n = this.length();
    if (!n) return 0;
    let s = 0;
    if (!this.full) {
      for (let k = 0; k < n; k++) s += this.a[k] * this.a[k];
    } else {
      for (let k = 0; k < this.size; k++) s += this.a[k] * this.a[k];
    }
    return Math.sqrt(s / (this.full ? this.size : n));
  }

  reset() {
    this.i = 0;
    this.full = false;
  }
}

function mulberry32(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(0xa11ce);

export function noise() {
  return (rand() * 2 - 1) * 0.9;
}

export function smoothstep(edge0: number, edge1: number, x: number) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

export function inferEegIntent(eegRms: number, sens: number) {
  const x = clamp01((eegRms - 0.18) * 2.2);
  const p = smoothstep(Math.max(0.05, 1 - sens), 1, x);
  if (p > 0.78) return 'F';
  if (p < 0.18) return 'STOP';
  return 'NEUTRAL';
}

export type ControlMode = 'manual' | 'assist' | 'neuro';

export interface ControlState {
  running: boolean;
  demo: boolean;
  armed: boolean;
  mode: ControlMode;
  speed: number;
  thr: number;
  sens: number;
}

export function buildPayload(cmd: string, s: ControlState) {
  return {
    t: Date.now(),
    cmd,
    speed: s.speed,
    mode: s.mode,
    armed: s.armed,
  };
}

export interface MetricsSnapshot {
  eegRms: number;
  eegBand: string;
  eegQuality: string;
  emgEnv: number;
  emgGate: boolean;
  emgThr: number;
  bpm: number;
  ecgStatus: string;
  eegCmd: string;
  mode: ControlMode;
  armed: boolean;
  demo: boolean;
  running: boolean;
  t: number;
}

export interface EngineMetrics {
  mEEGRms: string;
  qEEG: string;
  mEEGBand: string;
  mEEGCmd: string;
  mEMGEnv: string;
  mEMGThr: string;
  mEMGGate: string;
  qEMG: string;
  qECG: string;
  mECGBpm: string;
  mECGPeaks: string;
  mECGOk: string;
  buf: string;
  lat: string;
  nova: MetricsSnapshot;
}

let emgEnv = 0;
let ecgPeaks = 0;
let lastPeakAt = 0;
let bpm = 0;

export function resetSignalState() {
  emgEnv = 0;
  ecgPeaks = 0;
  lastPeakAt = 0;
  bpm = 0;
}

export function ingestFrame(
  frame: { eeg?: number | number[]; emg?: number | number[]; ecg?: number | number[] } | null,
  eegBuf: RingBuffer,
  emgBuf: RingBuffer,
  ecgBuf: RingBuffer,
) {
  if (!frame) return;
  const eeg = frame.eeg;
  const emg = frame.emg;
  const ecg = frame.ecg;

  if (Array.isArray(eeg) || Array.isArray(emg) || Array.isArray(ecg)) {
    const len = Math.max(
      Array.isArray(eeg) ? eeg.length : 0,
      Array.isArray(emg) ? emg.length : 0,
      Array.isArray(ecg) ? ecg.length : 0,
    );
    for (let i = 0; i < len; i++) {
      if (Array.isArray(eeg) && i < eeg.length) eegBuf.push(Number(eeg[i]) || 0);
      if (Array.isArray(emg) && i < emg.length) emgBuf.push(Number(emg[i]) || 0);
      if (Array.isArray(ecg) && i < ecg.length) ecgBuf.push(Number(ecg[i]) || 0);
    }
  } else {
    if (typeof eeg === 'number') eegBuf.push(eeg);
    if (typeof emg === 'number') emgBuf.push(emg);
    if (typeof ecg === 'number') ecgBuf.push(ecg);
  }
}

function nowMs() {
  return Date.now();
}

export function computeMetrics(
  eegBuf: RingBuffer,
  emgBuf: RingBuffer,
  ecgBuf: RingBuffer,
  s: ControlState,
  lastCmdAt: number,
): EngineMetrics {
  const eegRms = eegBuf.rms();
  const qEEG = eegRms > 0.55 ? 'NOISY' : eegRms > 0.25 ? 'OK' : 'CLEAN';
  const band = eegRms > 0.38 ? 'BETA' : eegRms > 0.25 ? 'ALPHA' : 'THETA';

  const emgArr = emgBuf.toArray();
  const lastEmg = emgArr.length ? emgArr[emgArr.length - 1] : 0;
  const rect = Math.abs(lastEmg);
  emgEnv = lerp(emgEnv, rect, 0.08);
  const gate = emgEnv >= s.thr;

  const ecgArr = ecgBuf.toArray();
  if (ecgArr.length > 3) {
    const a = ecgArr[ecgArr.length - 1];
    const b = ecgArr[ecgArr.length - 2];
    const c = ecgArr[ecgArr.length - 3];
    if (b > a && b > c && b > 0.65) {
      const t = nowMs();
      if (t - lastPeakAt > 280) {
        ecgPeaks++;
        if (lastPeakAt) {
          const rr = (t - lastPeakAt) / 1000;
          bpm = Math.max(35, Math.min(200, 60 / rr));
        }
        lastPeakAt = t;
      }
    }
  }

  const eegCmd = inferEegIntent(eegRms, s.sens);
  const ecgStatus = bpm ? (bpm > 120 ? 'FAST' : bpm < 55 ? 'SLOW' : 'NOMINAL') : 'WAIT';

  const buffer = Math.min(eegBuf.length(), emgBuf.length(), ecgBuf.length());
  const lat = lastCmdAt ? Math.max(0, nowMs() - lastCmdAt) : 0;

  const nova: MetricsSnapshot = {
    eegRms,
    eegBand: band,
    eegQuality: qEEG,
    emgEnv,
    emgGate: gate,
    emgThr: s.thr,
    bpm,
    ecgStatus,
    eegCmd,
    mode: s.mode,
    armed: s.armed,
    demo: s.demo,
    running: s.running,
    t: Date.now(),
  };

  const qECG = bpm ? `${fmt(bpm, 0)} BPM` : '—';

  return {
    mEEGRms: fmt(eegRms * 100, 1),
    qEEG,
    mEEGBand: band,
    mEEGCmd: eegCmd,
    mEMGEnv: fmt(emgEnv, 2),
    mEMGThr: fmt(s.thr, 2),
    mEMGGate: gate ? 'OPEN' : 'CLOSED',
    qEMG: gate ? 'ACTIVE' : 'REST',
    qECG,
    mECGBpm: bpm ? fmt(bpm, 0) : '—',
    mECGPeaks: String(ecgPeaks),
    mECGOk: bpm ? (bpm > 120 ? 'FAST' : bpm < 55 ? 'SLOW' : 'NOMINAL') : 'WAIT',
    buf: `${buffer}/${N}`,
    lat: lastCmdAt ? `${fmt(lat, 0)} ms` : '—',
    nova,
  };
}

export function generateDemoSamples(
  nSamples: number,
  startSampleIndex: number,
): { eeg: number; emg: number; ecg: number }[] {
  const out: { eeg: number; emg: number; ecg: number }[] = [];
  for (let i = 0; i < nSamples; i++) {
    const have = startSampleIndex + i;
    const t = have / SR;
    const alpha = Math.sin(2 * Math.PI * 10 * t) * 0.18;
    const beta = Math.sin(2 * Math.PI * 18 * t + 0.7) * 0.12;
    const drift = Math.sin(2 * Math.PI * 0.35 * t) * 0.1;
    const eeg = alpha + beta + drift + noise() * 0.05;

    const burst = smoothstep(0.05, 0.12, Math.sin(2 * Math.PI * 0.25 * t) * 0.5 + 0.5);
    const hf = Math.sin(2 * Math.PI * 60 * t) * 0.18 + Math.sin(2 * Math.PI * 90 * t) * 0.12;
    const emg = (hf + noise() * 0.35) * (0.15 + burst * 0.85);

    const hr = 72 + Math.sin(2 * Math.PI * 0.05 * t) * 4;
    const rr = 60 / hr;
    const phase = (t % rr) / rr;
    const p = Math.exp(-Math.pow((phase - 0.18) / 0.04, 2)) * 0.1;
    const q = -Math.exp(-Math.pow((phase - 0.3) / 0.015, 2)) * 0.18;
    const r = Math.exp(-Math.pow((phase - 0.33) / 0.01, 2)) * 0.95;
    const s = -Math.exp(-Math.pow((phase - 0.36) / 0.015, 2)) * 0.25;
    const tt = Math.exp(-Math.pow((phase - 0.6) / 0.09, 2)) * 0.22;
    const ecg = p + q + r + s + tt + noise() * 0.02;

    out.push({ eeg, emg, ecg });
  }
  return out;
}
