// Port of IEM-1176-reference. CompressorChain does not smooth; the wrapper does.
// Hardware-adjacent constants that were not measured on a unit are marked in the C++ headers.

export const kPi = 3.14159265358979323846;
export const kAol = 19.952623149688797;
export const kTurns = 15;
export const kTertiary = 0.5;
export const kFeedbackDivider = 0.5;
export const kBetaPath = (kFeedbackDivider * kTertiary) / kTurns;
export const kInvTurns = 1 / kTurns;
export const kAbKnee = 48;
export const kR5 = 27000;
export const kRdsMin = 400;
export const kRdsMax = 1e8;

export type RatioPosition = "R4" | "R8" | "R12" | "R20" | "All";
export type RevisionId = "RevA" | "RevD" | "RevE" | "RevF" | "RevG" | "LN";

export interface RatioLaw {
  ratio: number;
  thresholdShiftDb: number;
  attackScale: number;
  releaseScale: number;
}

export interface RevisionParameters {
  revision: RevisionId;
  inputTrimDb: number;
  ratio: RatioPosition;
  allButtonsModifier: boolean;
  attackUs: number;
  releaseMs: number;
  thresholdDb: number;
  outputGainDb: number;
  sidechainHpfHz: number;
  mixPct: number;
  lnDrive: number;
  oversampling: number;
}

export const HPF_CHOICES = [0, 60, 90, 150, 300] as const;

export function dbToLin(db: number): number {
  return 10 ** (db / 20);
}

export function linToDb(lin: number): number {
  return 20 * Math.log10(Math.max(lin, 1e-12));
}

function flush(x: number): number {
  return Math.abs(x) < 1e-30 ? 0 : x;
}

export function shapeLn(x: number, drive: number): number {
  const d = Math.min(1, Math.max(0, drive));
  const bias = 0.2 * d;
  const k = 1 + 2 * d;
  const tb = Math.tanh(bias);
  const ss = k * (1 - tb * tb);
  const y = Math.tanh(k * x + bias) - tb;
  return ss > 1e-12 ? y / ss : x;
}

export function applyLn(x: number, drive: number): number {
  const d = Math.min(1, Math.max(0, drive));
  if (d <= 1e-8) return x;
  return x + d * (shapeLn(x, 1) - x);
}

export function snapOversampling(factor: number): number {
  const allowed = [1, 2, 4, 8];
  let best = 1;
  let bestDist = 100;
  for (const a of allowed) {
    const dist = Math.abs(a - factor);
    if (dist < bestDist) {
      bestDist = dist;
      best = a;
    }
  }
  return best;
}

export function lawFor(position: RatioPosition): RatioLaw {
  switch (position) {
    case "R4":
      return { ratio: 4, thresholdShiftDb: 0, attackScale: 1, releaseScale: 1 };
    case "R8":
      return { ratio: 8, thresholdShiftDb: 0, attackScale: 1, releaseScale: 1 };
    case "R12":
      return { ratio: 12, thresholdShiftDb: 0, attackScale: 1, releaseScale: 1 };
    case "R20":
      return { ratio: 20, thresholdShiftDb: 0, attackScale: 1, releaseScale: 1 };
    case "All":
      return { ratio: 18, thresholdShiftDb: -3, attackScale: 0.35, releaseScale: 0.6 };
  }
}

export function effectiveLaw(position: RatioPosition, allButtons: boolean): RatioLaw {
  if (allButtons || position === "All") return lawFor("All");
  return lawFor(position);
}

export function lerpLaw(a: RatioLaw, b: RatioLaw, t: number): RatioLaw {
  const u = Math.min(1, Math.max(0, t));
  return {
    ratio: a.ratio + (b.ratio - a.ratio) * u,
    thresholdShiftDb: a.thresholdShiftDb + (b.thresholdShiftDb - a.thresholdShiftDb) * u,
    attackScale: a.attackScale + (b.attackScale - a.attackScale) * u,
    releaseScale: a.releaseScale + (b.releaseScale - a.releaseScale) * u,
  };
}

export function defaultParameters(): RevisionParameters {
  return {
    revision: "RevD",
    inputTrimDb: 0,
    ratio: "R4",
    allButtonsModifier: false,
    attackUs: 800,
    releaseMs: 300,
    thresholdDb: -24,
    outputGainDb: 0,
    sidechainHpfHz: 0,
    mixPct: 100,
    lnDrive: 0,
    oversampling: 8,
  };
}

class Sidechain {
  sr = 48000;
  atkSec = 800e-6;
  relSec = 0.3;
  threshDb = -20;
  ratio = 4;
  hpfHz = 0;
  atkCoef = 1;
  relCoef = 1;
  hpfA = 0;
  hpfX1 = 0;
  hpfY1 = 0;
  env = 0;

  prepare(sampleRate: number) {
    this.sr = Math.max(sampleRate, 1);
    this.recompute();
  }

  reset() {
    this.env = 0;
    this.hpfX1 = 0;
    this.hpfY1 = 0;
  }

  private recompute() {
    const a = this.atkSec;
    const r = this.relSec;
    const h = this.hpfHz;
    this.atkSec = -1;
    this.relSec = -1;
    this.hpfHz = -1;
    this.setAttackSeconds(a);
    this.setReleaseSeconds(r);
    this.setHpfFrequency(h);
  }

  setAttackSeconds(seconds: number) {
    const s = Math.max(seconds, 1e-7);
    if (s === this.atkSec) return;
    this.atkSec = s;
    this.atkCoef = 1 - Math.exp(-1 / (this.atkSec * this.sr));
  }

  setReleaseSeconds(seconds: number) {
    const s = Math.max(seconds, 1e-5);
    if (s === this.relSec) return;
    this.relSec = s;
    this.relCoef = 1 - Math.exp(-1 / (this.relSec * this.sr));
  }

  setThresholdDb(db: number) {
    this.threshDb = db;
  }

  setRatio(ratio: number) {
    this.ratio = Math.max(ratio, 1.001);
  }

  setHpfFrequency(hz: number) {
    if (hz === this.hpfHz) return;
    this.hpfHz = hz;
    if (this.hpfHz <= 0) {
      this.hpfA = 0;
      return;
    }
    this.hpfA = Math.exp((-2 * kPi * this.hpfHz) / this.sr);
  }

  processSample(detectorInput: number): number {
    const x = this.applyHpf(detectorInput);
    const level = Math.abs(x);
    const coef = level > this.env ? this.atkCoef : this.relCoef;
    this.env = flush(this.env + coef * (level - this.env));
    const thresh = dbToLin(this.threshDb);
    let g = 1;
    if (this.env > thresh && this.ratio > 1) {
      const over = this.env / thresh;
      g = over ** (1 / this.ratio - 1);
    }
    return g;
  }

  private applyHpf(x: number): number {
    if (this.hpfHz <= 0) return x;
    const y = this.hpfA * (this.hpfY1 + x - this.hpfX1);
    this.hpfX1 = x;
    this.hpfY1 = flush(y);
    return this.hpfY1;
  }
}

class Jfet {
  rds = kRdsMax;
  gain = kRdsMax / (kR5 + kRdsMax);

  setTargetGain(linearGain: number) {
    if (linearGain >= 0.999999) {
      this.rds = kRdsMax;
    } else {
      const g = Math.max(linearGain, 1e-8);
      this.rds = Math.min(kRdsMax, Math.max(kRdsMin, (g * kR5) / (1 - g)));
    }
    this.gain = this.rds / (kR5 + this.rds);
  }
}

export class CompressorChain {
  params: RevisionParameters = defaultParameters();
  law: RatioLaw = lawFor("R4");
  private blend = false;
  private sr = 48000;
  private factor = 8;
  private inputGain = 1;
  private outputGain = 1;
  private mix = 1;
  private ln = 0;
  private sidechain = new Sidechain();
  private jfet = new Jfet();
  private prevCell = 0;
  private fb = 0;
  private prevIn = 0;
  private prevExt = 0;
  lastGr = 0;
  resetCount = 0;
  private ext: Float32Array | number[] | null = null;
  private extN = 0;
  private gr: number[] = [];

  prepare(sampleRate: number) {
    this.sr = Math.max(sampleRate, 1);
    this.sidechain.prepare(this.sr * this.factor);
    this.pushCoefs();
  }

  reset() {
    this.sidechain.reset();
    this.prevCell = 0;
    this.fb = 0;
    this.prevIn = 0;
    this.prevExt = 0;
    this.lastGr = 0;
    this.ext = null;
    this.extN = 0;
    this.resetCount += 1;
  }

  setParameters(p: RevisionParameters) {
    this.params = p;
    const f = snapOversampling(p.oversampling);
    if (f !== this.factor) {
      this.factor = f;
      this.prevIn = 0;
      this.prevExt = 0;
      this.sidechain.prepare(this.sr * this.factor);
    }
    this.inputGain = dbToLin(p.inputTrimDb);
    this.outputGain = dbToLin(p.outputGainDb);
    this.mix = Math.min(1, Math.max(0, p.mixPct / 100));
    this.ln = Math.min(1, Math.max(0, p.lnDrive));
    if (!this.blend) this.law = effectiveLaw(p.ratio, p.allButtonsModifier);
    this.pushCoefs();
  }

  setEffectiveLaw(law: RatioLaw) {
    this.law = law;
    this.blend = true;
    this.pushCoefs();
  }

  setExternalSidechain(buffer: Float32Array | number[] | null, numSamples: number) {
    this.ext = buffer;
    this.extN = buffer ? Math.max(numSamples, 0) : 0;
  }

  setSidechainHpf(hz: number) {
    this.params = { ...this.params, sidechainHpfHz: hz };
    this.sidechain.setHpfFrequency(hz);
  }

  private pushCoefs() {
    const atk = Math.max(this.params.attackUs * 1e-6 * this.law.attackScale, 1e-6);
    const rel = Math.max(this.params.releaseMs * 1e-3 * this.law.releaseScale, 1e-4);
    this.sidechain.setAttackSeconds(atk);
    this.sidechain.setReleaseSeconds(rel);
    this.sidechain.setThresholdDb(this.params.thresholdDb + this.law.thresholdShiftDb);
    this.sidechain.setRatio(this.law.ratio);
    this.sidechain.setHpfFrequency(this.params.sidechainHpfHz);
  }

  private tickHigh(x: number, hasExt: boolean, extSample: number): { wet: number; grDb: number } {
    const detector = hasExt ? extSample : this.prevCell;
    const target = this.sidechain.processSample(detector);
    this.jfet.setTargetGain(target);
    const driven = this.ln > 1e-8 ? applyLn(x, this.ln) : x;
    const cell = driven * this.jfet.gain;
    const err = cell - this.fb;
    const primary = kAbKnee * Math.tanh((err * kAol) / kAbKnee);
    const secondary = primary * kInvTurns;
    this.fb = flush(kBetaPath * primary);
    this.prevCell = cell;
    const g = this.jfet.gain;
    return { wet: secondary, grDb: g >= 0.999999 ? 0 : -linToDb(g) };
  }

  processSample(x: number, hasExt: boolean, extSample: number): number {
    const trimmed = x * this.inputGain;
    let wetAcc = 0;
    let grAcc = 0;
    const n = this.factor;
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const s = this.prevIn + (trimmed - this.prevIn) * t;
      const detExt = hasExt ? this.prevExt + (extSample - this.prevExt) * t : 0;
      const tk = this.tickHigh(s, hasExt, detExt);
      wetAcc += tk.wet;
      grAcc += tk.grDb;
    }
    this.prevIn = trimmed;
    if (hasExt) this.prevExt = extSample;
    const wet = (wetAcc / n) * this.outputGain;
    this.lastGr = grAcc / n;
    return wet * this.mix + x * (1 - this.mix);
  }

  process(input: ArrayLike<number>, output: Float64Array | number[], numSamples: number) {
    for (let i = 0; i < numSamples; i++) {
      const has = this.ext != null && i < this.extN;
      output[i] = this.processSample(input[i] ?? 0, has, has ? (this.ext?.[i] ?? 0) : 0);
      this.gr[i] = this.lastGr;
    }
    this.ext = null;
    this.extN = 0;
  }

  gainReductionDb(): number[] {
    return this.gr;
  }

  oversamplingFactor(): number {
    return this.factor;
  }
}

interface Step {
  params: RevisionParameters;
  law: RatioLaw;
  resetChain: boolean;
  outputFade: number;
}

class ParameterSmoother {
  private sr = 48000;
  private coef = 0.001;
  private target = defaultParameters();
  private curIn = 0;
  private curAtk = 800;
  private curRel = 300;
  private curThr = -24;
  private curOut = 0;
  private curMix = 100;
  private curLn = 0;
  private hpf = 0;
  private os = 8;
  private revision: RevisionId = "RevD";
  private ratio: RatioPosition = "R4";
  private all = false;
  private lawFrom = lawFor("R4");
  private lawTo = lawFor("R4");
  private lawT = 1;
  private lawLeft = 0;
  private lawSpan = 1;
  private revLeft = 0;
  private revTotal = 1;
  private pendingReset = false;

  prepare(sampleRate: number) {
    this.sr = Math.max(sampleRate, 1);
    this.coef = 1 - Math.exp(-1 / (0.02 * this.sr));
  }

  reset(p: RevisionParameters) {
    this.target = { ...p };
    this.curIn = p.inputTrimDb;
    this.curAtk = p.attackUs;
    this.curRel = p.releaseMs;
    this.curThr = p.thresholdDb;
    this.curOut = p.outputGainDb;
    this.curMix = p.mixPct;
    this.curLn = p.lnDrive;
    this.hpf = p.sidechainHpfHz;
    this.os = p.oversampling;
    this.revision = p.revision;
    this.ratio = p.ratio;
    this.all = p.allButtonsModifier;
    this.lawFrom = effectiveLaw(p.ratio, p.allButtonsModifier);
    this.lawTo = this.lawFrom;
    this.lawT = 1;
    this.lawLeft = 0;
    this.revLeft = 0;
    this.revTotal = 1;
    this.pendingReset = false;
  }

  private snap(p: RevisionParameters) {
    this.curIn = p.inputTrimDb;
    this.curAtk = p.attackUs;
    this.curRel = p.releaseMs;
    this.curThr = p.thresholdDb;
    this.curOut = p.outputGainDb;
    this.curMix = p.mixPct;
    this.curLn = p.lnDrive;
  }

  private currentLaw(): RatioLaw {
    return lerpLaw(this.lawFrom, this.lawTo, this.lawT);
  }

  setTargets(p: RevisionParameters) {
    if (p.revision !== this.revision) {
      this.revision = p.revision;
      this.revTotal = Math.max(1, Math.round(0.03 * this.sr));
      this.revLeft = this.revTotal;
      this.pendingReset = true;
      this.snap(p);
    }
    if (p.ratio !== this.ratio || p.allButtonsModifier !== this.all) {
      this.lawFrom = this.currentLaw();
      this.ratio = p.ratio;
      this.all = p.allButtonsModifier;
      this.lawTo = effectiveLaw(this.ratio, this.all);
      this.lawLeft = Math.max(1, Math.round(0.005 * this.sr));
      this.lawSpan = this.lawLeft;
      this.lawT = 0;
    }
    this.hpf = p.sidechainHpfHz;
    this.os = p.oversampling;
    this.target = { ...p };
  }

  loadPreset(p: RevisionParameters) {
    this.reset(p);
    this.target = { ...p };
  }

  advance(): Step {
    this.curIn += this.coef * (this.target.inputTrimDb - this.curIn);
    this.curAtk += this.coef * (this.target.attackUs - this.curAtk);
    this.curRel += this.coef * (this.target.releaseMs - this.curRel);
    this.curThr += this.coef * (this.target.thresholdDb - this.curThr);
    this.curOut += this.coef * (this.target.outputGainDb - this.curOut);
    this.curMix += this.coef * (this.target.mixPct - this.curMix);
    this.curLn += this.coef * (this.target.lnDrive - this.curLn);

    let resetChain = false;
    let outputFade = 1;
    if (this.revLeft > 0) {
      const pos = this.revTotal - this.revLeft;
      const u = pos / this.revTotal;
      outputFade = u < 0.5 ? 1 - u * 2 : (u - 0.5) * 2;
      if (this.pendingReset && pos >= this.revTotal / 2) {
        resetChain = true;
        this.pendingReset = false;
      }
      this.revLeft -= 1;
    }
    if (this.lawLeft > 0) {
      this.lawT = 1 - this.lawLeft / this.lawSpan;
      this.lawLeft -= 1;
      if (this.lawLeft === 0) this.lawT = 1;
    } else {
      this.lawT = 1;
    }

    return {
      params: {
        revision: this.revision,
        inputTrimDb: this.curIn,
        ratio: this.ratio,
        allButtonsModifier: this.all,
        attackUs: this.curAtk,
        releaseMs: this.curRel,
        thresholdDb: this.curThr,
        outputGainDb: this.curOut,
        sidechainHpfHz: this.hpf,
        mixPct: this.curMix,
        lnDrive: this.curLn,
        oversampling: this.os,
      },
      law: this.currentLaw(),
      resetChain,
      outputFade,
    };
  }
}

export interface MeterFrame {
  gr: number;
  inPeak: number;
  outPeak: number;
}

/** Realtime wrapper. Call only from the audio thread or an offline render. */
export class PluginWrapper {
  readonly main = new CompressorChain();
  private shadow = new CompressorChain();
  private shadowParams = defaultParameters();
  private shadowLaw = lawFor("R4");
  private smoother = new ParameterSmoother();
  private sr = 48000;
  private fading = false;
  private fadeTotal = 1;
  private fadePos = 0;
  private bypassMix = 0;
  private bypassTarget = 0;
  private ext: Float32Array | null = null;
  private extN = 0;
  inPeak = 0;
  outPeak = 0;

  prepare(sampleRate: number) {
    this.sr = sampleRate;
    this.main.prepare(sampleRate);
    this.shadow.prepare(sampleRate);
    this.smoother.prepare(sampleRate);
    this.smoother.reset(defaultParameters());
    this.apply(this.smoother.advance());
  }

  setTargets(p: RevisionParameters) {
    this.smoother.setTargets(p);
  }

  loadPreset(p: RevisionParameters) {
    this.shadow = this.cloneChain(this.main);
    this.shadowParams = { ...this.main.params };
    this.shadowLaw = { ...this.main.law };
    this.smoother.loadPreset(p);
    this.fading = true;
    this.fadeTotal = Math.max(1, Math.round(0.03 * this.sr));
    this.fadePos = 0;
  }

  setHostBypass(bypass: boolean) {
    this.bypassTarget = bypass ? 1 : 0;
  }

  setExternalSidechain(buffer: Float32Array | null, numSamples: number) {
    this.ext = buffer;
    this.extN = buffer ? numSamples : 0;
  }

  processBlock(input: Float32Array, output: Float32Array, sidechain: Float32Array | null) {
    let inPk = 0;
    let outPk = 0;
    const n = input.length;
    const bCoef = 1 - Math.exp(-1 / (0.01 * this.sr));
    for (let i = 0; i < n; i++) {
      const x = input[i] ?? 0;
      const step = this.smoother.advance();
      if (step.resetChain) this.main.reset();
      this.main.setParameters(step.params);
      this.main.setEffectiveLaw(step.law);
      const has = sidechain != null && i < sidechain.length;
      const ext = has ? (sidechain?.[i] ?? 0) : 0;
      let wet = this.main.processSample(x, has, ext);
      if (this.fading) {
        this.shadow.setParameters(this.shadowParams);
        this.shadow.setEffectiveLaw(this.shadowLaw);
        const old = this.shadow.processSample(x, has, ext);
        const t = this.fadePos / this.fadeTotal;
        const g1 = Math.sin(t * kPi * 0.5);
        const g0 = Math.cos(t * kPi * 0.5);
        wet = old * g0 + wet * g1;
        this.fadePos += 1;
        if (this.fadePos >= this.fadeTotal) this.fading = false;
      }
      this.bypassMix += bCoef * (this.bypassTarget - this.bypassMix);
      let y = wet * (1 - this.bypassMix) + x * this.bypassMix;
      y *= step.outputFade;
      output[i] = y;
      const ax = Math.abs(x);
      const ay = Math.abs(y);
      if (ax > inPk) inPk = ax;
      if (ay > outPk) outPk = ay;
    }
    this.inPeak = inPk;
    this.outPeak = outPk;
    this.ext = null;
    this.extN = 0;
  }

  private apply(step: Step) {
    this.main.setParameters(step.params);
    this.main.setEffectiveLaw(step.law);
  }

  private cloneChain(src: CompressorChain): CompressorChain {
    // Structured clone of the numeric state via a fresh chain is not enough:
    // preset crossfade needs the detector memory. JSON copy the fields we own.
    const copy = new CompressorChain();
    copy.prepare(this.sr);
    copy.setParameters({ ...src.params });
    copy.setEffectiveLaw({ ...src.law });
    const bag = src as unknown as Record<string, unknown>;
    const dst = copy as unknown as Record<string, unknown>;
    dst.prevCell = bag.prevCell;
    dst.fb = bag.fb;
    dst.prevIn = bag.prevIn;
    dst.prevExt = bag.prevExt;
    dst.lastGr = bag.lastGr;
    const sc = bag.sidechain as Record<string, number>;
    const sc2 = dst.sidechain as Record<string, number>;
    sc2.env = sc.env;
    sc2.hpfX1 = sc.hpfX1;
    sc2.hpfY1 = sc.hpfY1;
    sc2.atkCoef = sc.atkCoef;
    sc2.relCoef = sc.relCoef;
    sc2.hpfA = sc.hpfA;
    sc2.atkSec = sc.atkSec;
    sc2.relSec = sc.relSec;
    sc2.hpfHz = sc.hpfHz;
    sc2.threshDb = sc.threshDb;
    sc2.ratio = sc.ratio;
    sc2.sr = sc.sr;
    const jf = bag.jfet as { rds: number; gain: number };
    const jf2 = dst.jfet as { rds: number; gain: number };
    jf2.rds = jf.rds;
    jf2.gain = jf.gain;
    return copy;
  }
}

export function sanitizeParameters(p: RevisionParameters): RevisionParameters {
  const hpf = nearest(HPF_CHOICES, p.sidechainHpfHz);
  const ratios: RatioPosition[] = ["R4", "R8", "R12", "R20", "All"];
  const ratio = ratios.includes(p.ratio) ? p.ratio : "R4";
  return {
    revision: p.revision ?? "RevD",
    inputTrimDb: clamp(p.inputTrimDb, -24, 24),
    ratio,
    allButtonsModifier: Boolean(p.allButtonsModifier || ratio === "All"),
    attackUs: clamp(p.attackUs, 20, 800),
    releaseMs: clamp(p.releaseMs, 50, 1100),
    thresholdDb: clamp(p.thresholdDb, -48, 0),
    outputGainDb: clamp(p.outputGainDb, -24, 24),
    sidechainHpfHz: hpf,
    mixPct: clamp(p.mixPct, 0, 100),
    lnDrive: clamp(p.lnDrive, 0, 1),
    oversampling: snapOversampling(p.oversampling),
  };
}

function clamp(v: number, a: number, b: number): number {
  if (!Number.isFinite(v)) return a;
  return Math.min(b, Math.max(a, v));
}

function nearest(choices: readonly number[], value: number): number {
  let best = choices[0] ?? 0;
  let dist = Infinity;
  for (const c of choices) {
    const d = Math.abs(c - value);
    if (d < dist) {
      dist = d;
      best = c;
    }
  }
  return best;
}

export async function measureSteadyGr(
  params: RevisionParameters,
  external: boolean,
  sampleRate = 48000,
): Promise<number> {
  const chain = new CompressorChain();
  chain.prepare(sampleRate);
  chain.reset();
  chain.setParameters(params);
  const total = sampleRate * 5;
  const block = 256;
  const input = new Float64Array(block);
  const output = new Float64Array(block);
  let sum = 0;
  let count = 0;
  for (let idx = 0; idx < total; idx += block) {
    const n = Math.min(block, total - idx);
    for (let i = 0; i < n; i++) {
      input[i] = Math.sin((2 * kPi * 1000 * (idx + i)) / sampleRate);
    }
    if (external) chain.setExternalSidechain(input, n);
    chain.process(input, output, n);
    const gr = chain.gainReductionDb();
    for (let i = 0; i < n; i++) {
      const t = idx + i;
      if (t >= sampleRate * 2 && t < sampleRate * 5) {
        sum += gr[i] ?? 0;
        count += 1;
      }
    }
    if (idx % (sampleRate * 1) === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return count ? sum / count : 0;
}
